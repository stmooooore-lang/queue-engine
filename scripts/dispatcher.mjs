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
} from "./executor.mjs";

// Ensure all console logs, errors and stream outputs in dispatcher are masked against secret leaks
installSecretRedactionHook();

const client = createClient({ url: process.env.TURSO_DATABASE_URL || "file::memory:", authToken: process.env.TURSO_AUTH_TOKEN });

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

async function main() {
  if (executorAlreadyRunning()) {
    console.log(mask_secrets(`[${new Date().toISOString()}] executor.yml already has a run in flight, dispatching nothing this tick`));
    return;
  }

  const pending = await client.execute({
    sql: "SELECT id, text FROM tasks WHERE status = 'ожидает' ORDER BY id ASC",
  });

  for (const task of pending.rows) {
    if (!(await siblingOrderOk(task))) {
      console.log(mask_secrets(`[${new Date().toISOString()}] task ${task.id}: waiting on an earlier unaccepted sibling, skipping`));
      continue;
    }
    const stuckCheck = detectStuckTask(task);
    if (stuckCheck.stuck) {
      console.log(mask_secrets(`[${new Date().toISOString()}] task ${task.id}: detected stuck loop (${stuckCheck.reason}), skipping dispatch`));
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
  main,
  client,
  redactSecrets,
  mask_secrets,
  installSecretRedactionHook,
  classifyProgressVsLoop,
  classifyTimeoutKill,
  detectLoop,
  detectStuckTask,
};

if (process.argv[1] && process.argv[1].endsWith('dispatcher.mjs')) {
  main().catch((e) => {
    console.error(mask_secrets(e?.stack || e?.message || e));
    process.exit(1);
  });
}
