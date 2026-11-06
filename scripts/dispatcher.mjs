/**
 * Cron dispatcher for the cloud queue.
 *
 * Real gap this closes (decided 2026-09-12): unlike the old scripts/poller.mjs
 * (which polled Turso itself in a loop), .github/workflows/executor.yml only
 * runs on an explicit workflow_dispatch with a taskId - it never scans the
 * tasks table for pending work on its own. Inserting a Turso row is not
 * sufficient by itself for a task to get picked up unless something else also
 * calls the dispatch API right after. This script is that something else,
 * run on a schedule by .github/workflows/dispatcher.yml.
 *
 * Correctness note: this intentionally does NOT track "already dispatched"
 * state anywhere. executor.mjs's own claim query
 * (`SELECT * FROM tasks WHERE id = ? AND status = 'ожидает'`, see run() at
 * the top of executor.mjs) is already race-safe - a second dispatch for a
 * taskId whose first run already flipped status to 'выполняется' just finds
 * no row and exits cleanly ("No pending task found"). Worst case from firing
 * twice for the same task in one tick is one harmless extra Actions run, not
 * a correctness bug. That existing guarantee is why this stays this small.
 *
 * One task in flight at a time, 2026-09-14 - the founder's real, direct
 * correction: "ОЧЕРЕДЬ - это когда последовательно" (a QUEUE means
 * sequential). The first version dispatched up to 5 tasks per tick with no
 * check for what was already running, and the very first real tick fired 5
 * of plexus-doc-cc's tasks within ~8 seconds of each other - all 5 then
 * failed on the same provider rate limits (groq/nvidia/mistral), competing
 * for one shared TPM budget instead of queuing behind each other the way
 * the local queue.sh always has. Fixed by checking for any executor.yml run
 * already queued/in_progress before dispatching, and dispatching at most one
 * task per tick if so - the next tick (10 min later) picks up the next one,
 * same one-at-a-time posture as the local queue.
 */

import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";

// CLOUD-MAINT-c-d, 2026-10-09: the sibling-task parser (the [SIB i/n
// parent:P] marker format, its parse/extract routines and the order guard)
// now lives in one shared module used by both this dispatcher and
// executor.mjs. Until now this file kept a second, hand-synced copy of
// parseSiblingMarker/siblingOrderOk (ported here in GHQ2-c), and
// CLOUD-MAINT-c-c then had to apply the same fail-closed fix twice - once
// per copy.
import { parseSiblingMarker, makeSiblingOrderOk } from "./sibling-parser.mjs";
import {
  redactSecrets,
  redactSecrets as mask_secrets,
  installSecretRedactionHook,
  classifyProgressVsLoop,
  classifyTimeoutKill,
  detectLoop,
  detectStuckTask,
  TASK_STATUSES,
  EXECUTION_EVENTS,
  writeChatAlert,
  isRetryableFailureTask,
} from "./executor.mjs";

// Ensure all console logs, errors and stream outputs in dispatcher are masked against secret leaks
installSecretRedactionHook();

const client = createClient({ url: process.env.TURSO_DATABASE_URL || "file::memory:", authToken: process.env.TURSO_AUTH_TOKEN });

// AUTO-LOWER-ON-STALE (cloud): automatic priority lowering for stale escalations
const ESCALATION_STALE_HOURS = Number(process.env.ESCALATION_STALE_HOURS) || 24;
const ESCALATION_MAX_LOWER = Number(process.env.ESCALATION_MAX_LOWER) || 3;

// Same sibling-order guard as executor.mjs, from the single shared
// implementation in sibling-parser.mjs, bound to this dispatcher's own
// client. Semantics unchanged (CLOUD-MAINT-c-c): an out-of-order sibling
// waits for its predecessor to be 'готова'; a missing predecessor or a DB
// error fails closed.
const siblingOrderOk = makeSiblingOrderOk(client);

const REPO = process.env.GITHUB_REPOSITORY || "stmooooore-lang/queue-engine"; // "owner/repo", set automatically by Actions

// One task in flight at a time (see the file header) - if executor.yml
// already has a queued or in_progress run, this tick dispatches nothing and
// waits for the next one. `gh run list --json status` returns real GitHub
// Actions run status strings ("queued", "in_progress", "completed", ...).
function executorAlreadyRunning() {
  try {
    const out = execFileSync(
      "gh",
      ["run", "list", "--workflow", "executor.yml", "--repo", REPO, "--json", "status", "--limit", "20"],
      { env: process.env, stdio: "pipe" }
    ).toString();
    const runs = JSON.parse(out);
    return runs.some((r) => r.status === "queued" || r.status === "in_progress");
  } catch (e) {
    console.error(mask_secrets(`[${new Date().toISOString()}] executorAlreadyRunning check failed: ${e.message}`));
    return false;
  }
}

  // RETRY-BUDGET, 2026-11-06: the one SELECT that decides what the
// dispatcher may run this tick. Exported so tests/retry-budget.mjs verifies
// THIS query rather than a hand-synced copy of it - a copy tests itself.
const DISPATCH_SELECT_SQL =
  "SELECT id, text, metadata, status, blocked_reason FROM tasks WHERE ((status = 'ожидает' OR status = 'провал') AND (paused_until IS NULL OR paused_until <= CURRENT_TIMESTAMP) AND (status = 'ожидает' OR ((blocked_reason IS NULL OR blocked_reason = '') AND CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata,'$.retry_count'),0) ELSE 0 END < 3 AND CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata,'$.failed_at'),0) ELSE 0 END > 0 AND CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata,'$.failed_at'),0) ELSE 0 END <= CAST(strftime('%s','now') AS INTEGER) - 300))) ORDER BY id ASC";

async function main() {

if (executorAlreadyRunning()) {
    console.log(mask_secrets(`[${new Date().toISOString()}] executor.yml already has a run in flight, dispatching nothing this tick`));
    return;
  }

  // RETRY-BUDGET, 2026-11-06: pull BOTH fresh work and retryable failures
  // back into the queue in one SELECT. A transient 'провал' (401, 429, 503,
  // timeout, ECONNRESET) keeps its verdict but is worth another attempt once
  // RETRY_AFTER_SECONDS have passed and the budget is unspent. A
  // 'провал_фатальный' is absent on purpose - it is terminal and the SIB
  // cascade has already resolved its chain.
  //
  // json_valid() guards every json_extract(): metadata is a free-text JSON
  // column and a malformed or absent value must not take the whole tick down
  // with a SQLITE_ERROR. A legacy 'провал' row (written before this change,
  // so no metadata at all) is picked up with retry_count 0 and a 0
  // failed_at - it gets one immediate attempt and then carries real
  // bookkeeping, so the hotfix cannot freeze a queue full of old verdicts.
  const pending = await client.execute({
    sql: DISPATCH_SELECT_SQL,
  });

  // AUTO-LOWER-ON-STALE: check for stale escalations before dispatching
  for (const task of pending.rows) {
    let metadata = {};
    if (task.metadata) {
      try { metadata = JSON.parse(task.metadata); } catch {}
    }
    const escalatedAt = metadata.escalated_at;
    const escalationCount = metadata.escalation_count || 0;

    if (escalatedAt) {
      const escalatedTime = new Date(escalatedAt).getTime();
      const now = Date.now();
      const hoursSinceEscalation = (now - escalatedTime) / (1000 * 60 * 60);

      if (hoursSinceEscalation > ESCALATION_STALE_HOURS) {
        // Stale escalation - lower priority
        if (escalationCount < ESCALATION_MAX_LOWER) {
          // Move to end of queue by setting paused_until to a future time
          // Use a large delay (24 hours) to effectively push it behind other tasks
          const newPausedUntil = new Date(now + 24 * 60 * 60 * 1000).toISOString();
          const newEscalationCount = escalationCount + 1;
          metadata.escalation_count = newEscalationCount;
          metadata.escalated_at = new Date().toISOString(); // Reset escalation timestamp

          await client.execute({
            sql: "UPDATE tasks SET paused_until = ?, metadata = ? WHERE id = ?",
            args: [newPausedUntil, JSON.stringify(metadata), task.id]
          });

          console.log(mask_secrets(`[${new Date().toISOString()}] [AUTO-LOWER] task ${task.id}: stale escalation (${hoursSinceEscalation.toFixed(1)}h > ${ESCALATION_STALE_HOURS}h), lowered priority (count: ${newEscalationCount}/${ESCALATION_MAX_LOWER})`));
          
          await writeChatAlert({
            type: EXECUTION_EVENTS.AUTO_LOWER,
            task: task.id,
            from: null,
            to: null,
            error: `Auto-lowered priority (escalation stale > ${ESCALATION_STALE_HOURS}h)`,
            details: `Task ${task.id} escalation was ${hoursSinceEscalation.toFixed(1)}h old. Lowered priority: count ${newEscalationCount}/${ESCALATION_MAX_LOWER}. Paused until ${newPausedUntil}`
          }, client).catch(() => {});
        } else {
          // Max lowers reached - leave in queue but don't lower further
          console.log(mask_secrets(`[${new Date().toISOString()}] [AUTO-LOWER] task ${task.id}: max lowers reached (${ESCALATION_MAX_LOWER}), leaving at end of queue`));
          
          await writeChatAlert({
            type: EXECUTION_EVENTS.AUTO_LOWER,
            task: task.id,
            from: null,
            to: null,
            error: `Max auto-lowers reached (${ESCALATION_MAX_LOWER})`,
            details: `Task ${task.id} has reached max auto-lower count. Remaining at end of queue without further lowering.`
          }, client).catch(() => {});
        }
        // Skip this task for this tick since we just lowered its priority
        continue;
      }
    }

    // RETRY-BUDGET: the SQL above is a coarse filter; the shared rule in
    // executor.mjs is the authority. Re-checking here means the two contours
    // can never disagree about what "retryable" means (Local-Cloud Parity).
    if (task.status === 'провал' && !isRetryableFailureTask(task)) {
      console.log(mask_secrets(`[${new Date().toISOString()}] task ${task.id}: 'провал' is not retryable (spent budget or founder-fixable block), skipping`));
      continue;
    }
    if (!(await siblingOrderOk(task))) {
      console.log(mask_secrets(`[${new Date().toISOString()}] task ${task.id}: waiting on an earlier unaccepted sibling, skipping`));
      continue;
    }
    const stuckCheck = detectStuckTask(task);
    if (stuckCheck.stuck) {
      console.log(mask_secrets(`[${new Date().toISOString()}] task ${task.id}: detected stuck loop (${stuckCheck.reason}), skipping dispatch`));
      await writeChatAlert({
        type: EXECUTION_EVENTS.STUCK_TASK,
        task: task.id,
        error: stuckCheck.reason,
        details: `Task ${task.id} stuck in loop: ${stuckCheck.reason}`,
      }, client).catch(() => {});
      continue;
    }
    try {
      const out = execFileSync("gh", ["workflow", "run", "executor.yml", "--repo", REPO, "-f", `taskId=${task.id}`], {
        stdio: "pipe",
        env: process.env,
      });
      if (out && out.length > 0) {
        console.log(mask_secrets(out.toString().trim()));
      }
      console.log(mask_secrets(`[${new Date().toISOString()}] dispatched executor.yml for task ${task.id}, stopping - one at a time`));
      return;
    } catch (e) {
      console.error(mask_secrets(`[${new Date().toISOString()}] failed to dispatch task ${task.id}: ${e.message}`));
    }
  }

  console.log(mask_secrets(`[${new Date().toISOString()}] tick done: nothing ready to dispatch out of ${pending.rows.length} pending`));
}

export {
  parseSiblingMarker,
  siblingOrderOk,
  executorAlreadyRunning,
  DISPATCH_SELECT_SQL,
  main,
  client,
  redactSecrets,
  mask_secrets,
  installSecretRedactionHook,
  classifyProgressVsLoop,
  classifyTimeoutKill,
  detectLoop,
  detectStuckTask,
  TASK_STATUSES,
  EXECUTION_EVENTS,
  writeChatAlert,
};

if (process.argv[1] && process.argv[1].endsWith('dispatcher.mjs')) {
  main().catch((e) => {
    console.error(mask_secrets(e?.stack || e?.message || e));
    process.exit(1);
  });
}
