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
 */

import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";

const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// Ported from executor.mjs's own parseSiblingMarker/siblingOrderOk (GHQ2-c,
// 2026-09-14) - same [SIB i/n parent:P] text-embedded marker, same
// fail-open-on-error posture. Kept in sync by hand since this is a separate
// process with its own short lifetime, not worth sharing a module for two
// small functions.
function parseSiblingMarker(text) {
  const m = String(text || "").match(/^\[SIB (\d+)\/(\d+) parent:(\d+)\]/);
  if (!m) return null;
  return { index: Number(m[1]), total: Number(m[2]), parentId: Number(m[3]) };
}

async function siblingOrderOk(task) {
  const sib = parseSiblingMarker(task.text);
  if (!sib || sib.index <= 1) return true;
  try {
    const res = await client.execute({
      sql: "SELECT status FROM tasks WHERE text LIKE ? LIMIT 1",
      args: [`[SIB ${sib.index - 1}/${sib.total} parent:${sib.parentId}]%`],
    });
    const prev = res.rows[0];
    if (!prev) return true;
    return prev.status === "готова";
  } catch {
    return true;
  }
}

const MAX_DISPATCHES_PER_TICK = Number(process.env.MAX_DISPATCHES_PER_TICK || 5);
const REPO = process.env.GITHUB_REPOSITORY; // "owner/repo", set automatically by Actions

async function main() {
  const pending = await client.execute({
    sql: "SELECT id, text FROM tasks WHERE status = 'ожидает' ORDER BY id ASC",
  });

  let dispatched = 0;
  for (const task of pending.rows) {
    if (dispatched >= MAX_DISPATCHES_PER_TICK) {
      console.log(`[${new Date().toISOString()}] reached MAX_DISPATCHES_PER_TICK=${MAX_DISPATCHES_PER_TICK}, stopping this tick`);
      break;
    }
    if (!(await siblingOrderOk(task))) {
      console.log(`[${new Date().toISOString()}] task ${task.id}: waiting on an earlier unaccepted sibling, skipping`);
      continue;
    }
    try {
      execFileSync("gh", ["workflow", "run", "executor.yml", "--repo", REPO, "-f", `taskId=${task.id}`], {
        stdio: "inherit",
        env: process.env,
      });
      console.log(`[${new Date().toISOString()}] dispatched executor.yml for task ${task.id}`);
      dispatched++;
    } catch (e) {
      console.error(`[${new Date().toISOString()}] failed to dispatch task ${task.id}: ${e.message}`);
    }
  }

  console.log(`[${new Date().toISOString()}] tick done: ${dispatched} dispatched, ${pending.rows.length} were pending`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
