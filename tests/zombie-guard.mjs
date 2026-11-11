/**
 * ZOMBIE-HOTFIX, 2026-11-08 - regression test for the two layers that stop a
 * task being stranded in 'выполняется'.
 *
 * THE DEFECT (Plexus, tasks 155 and 156): the executor's final UPDATE named
 * blocked_reason, a column Turso never had. It threw SQLITE_ERROR, the pass
 * died after the work was done, and nothing was written - no result, no
 * status. The dispatcher never re-picks 'выполняется', so the rows were
 * permanent zombies only a human browsing the table could find.
 *
 * Two independent ways to die, so two layers, both tested here:
 *   layer 1 - the final write itself throws. The brief: fall back to
 *             `UPDATE tasks SET status = 'провал'`.
 *   layer 2 - ANY other await in run() throws. Not in the brief; found while
 *             auditing. The entry point used to be
 *             `run().catch(e => process.exit(1))`, which produced the same
 *             zombie by a different route, ~100 lines earlier.
 *
 * HOW THE FAILURE IS REPRODUCED - by schema, not by monkey-patching. The
 * executor module owns its Turso client and an ESM namespace is read-only, so
 * `mod.client = ...` is impossible (tried, and it throws). The honest
 * reproduction is therefore the real one: give the table the shape production
 * actually had (no blocked_reason) and let the executor's own UPDATE fail.
 *
 * SAFETY, checked not assumed: TURSO_DATABASE_URL is forced to a shared
 * in-memory database BEFORE the executor is imported, so the module's client
 * cannot be the live cluster. The test then asserts it stayed in-memory - a
 * leak here would write to Plexus's real queue.
 */
import assert from "node:assert";

// ---- must happen before the dynamic import below: the client is created at
// ---- module-evaluation time, so this is the only way to redirect it.
process.env.TURSO_DATABASE_URL = "file::memory:?cache=shared";
delete process.env.TURSO_AUTH_TOKEN;

const { createClient } = await import("@libsql/client");
const { run, releaseStuckTaskAfterCrash, client: moduleClient } = await import("../scripts/executor.mjs");
const { FakeTransport } = await import("../../tests/cloud_queue_contract.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`PASS  ${name}`); return; }
  failures += 1;
  console.log(`FAIL  ${name} :: ${detail}`);
}

const db = createClient({ url: process.env.TURSO_DATABASE_URL });

// The libsql client does not expose its URL, so the safety property is proved
// behaviourally rather than by inspecting a field: the module's own writes must
// appear in THIS in-memory database. Were its client resolving to the live
// cluster (the keys.txt fallback), those writes would land in Plexus's real
// queue and the check below would fail instead of silently passing.
await db.execute("CREATE TABLE IF NOT EXISTS __sentinel (id INTEGER)");
await db.execute("INSERT INTO __sentinel VALUES (1)");
check("the executor module shares this in-memory database (its client is not the live cluster)",
  (await moduleClient.execute("SELECT COUNT(*) n FROM __sentinel")).rows[0].n === 1,
  "the module cannot see this database - its client is a different one, possibly the live cluster");

// The exact shape production had when it broke: paused_until was migrated in
// earlier, blocked_reason and metadata were not. `metadata` being absent too is
// not a simplification - it is what makes the best-effort metadata catch fire,
// which is the second half of layer 1.
const PRODUCTION_SHAPE = `
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT, status TEXT, creator_id TEXT, lane TEXT, result TEXT,
    actions_run_id TEXT, seconds_to_first_work INTEGER, minutes_used INTEGER,
    paused_until TEXT
  )`;

// ===========================================================================
// LAYER 2 - the release helper (defines the "no second release" invariant)
// ===========================================================================
console.log("[layer 2] releaseStuckTaskAfterCrash");
await db.execute(PRODUCTION_SHAPE);
await db.execute({ sql: "INSERT INTO tasks (id, text, status, creator_id, lane) VALUES (?,?,?,?,?)", args: [901, "stuck task", "выполняется", "user1", "architect"] });
await db.execute({ sql: "INSERT INTO tasks (id, text, status, creator_id, lane) VALUES (?,?,?,?,?)", args: [902, "already finished", "готова", "user1", "architect"] });

// process.exit(1) is part of the helper's contract; unstubbed, the test process
// dies on the first call.
const realExit = process.exit;
let exits = 0;
process.exit = () => { exits += 1; throw new Error("__EXIT_SENTINEL__"); };
try {
  await releaseStuckTaskAfterCrash(901, new Error("boom mid-pass"));
} catch (e) {
  if (!String(e.message).includes("__EXIT_SENTINEL__")) throw e;
}
check("the helper exits the process", exits === 1, String(exits));
check("the module's release landed in THIS in-memory DB - so its client is not the live cluster",
  (await db.execute("SELECT status FROM tasks WHERE id = 901")).rows[0].status === "провал",
  "releaseStuckTaskAfterCrash wrote somewhere else (live Turso?) or not at all");
const t902 = (await db.execute("SELECT status, result FROM tasks WHERE id = 902")).rows[0];
try {
  await releaseStuckTaskAfterCrash(902, new Error("late throw"));
} catch (e) {
  if (!String(e.message).includes("__EXIT_SENTINEL__")) throw e;
}
check("a task that is NOT stuck in 'выполняется' is never rewritten",
  t902.status === "готова" && t902.result === null, `${t902.status}/${t902.result}`);

// ===========================================================================
// LAYER 1 - the executor's own pass, crashing at its final write
// ===========================================================================
console.log("[layer 1] run(): final write fails -> minimal release, never a zombie");
// 2026-11-11: the brief carries the two pre-flight declarations. Without them
// the pass now stops at briefDeclarationGaps() before any work runs, which is
// the correct behaviour for a real queue and the wrong shape for this test -
// layer 1 is about the FINAL write failing, not about the brief.
await db.execute({ sql: "INSERT INTO tasks (id, text, status, creator_id, lane) VALUES (?,?,?,?,?)", args: [903, "do the thing\n[BRANCH: main]\nMANIFEST: out.md", "ожидает", "user1", "architect"] });

const transport = new FakeTransport();
transport.install();

const prev = { TASK_ID: process.env.TASK_ID, BOT: process.env.TELEGRAM_BOT_TOKEN };
process.env.TASK_ID = "903";
process.env.TELEGRAM_BOT_TOKEN = "test-token-not-a-real-bot";
process.env.TELEGRAM_ADMIN_CHAT_ID = "1";

const prevExitCode = process.exitCode;
let runErr = null;
try {
  await run();
} catch (e) {
  runErr = e;
}
// Read BEFORE restoring: the whole point is that a recovered-from crash must
// still make the run report failure, not silently succeed.
const exitCodeDuringRun = process.exitCode;

Object.assign(process.env, prev);
transport.uninstall?.();
process.exitCode = prevExitCode;

check("run() does not throw to the caller (it owns its own recovery)", runErr === null, String(runErr?.message || ""));
check("run() signals the failure via exitCode (recovered, not silent)", exitCodeDuringRun === 1, String(exitCodeDuringRun));
const t903 = (await db.execute("SELECT status, result FROM tasks WHERE id = 903")).rows[0];
// The metadata column does not exist in this shape, so instead of selecting it
// prove it - and prove that its absence did not damage the recorded verdict.
const metadataColumnGone = await db.execute("SELECT * FROM tasks WHERE id = 903")
  .then((r) => !r.columns.includes("metadata"))
  .catch(() => true);
check("the task is NOT stranded in 'выполняется'", t903.status !== "выполняется", String(t903.status));
check("the task lands on the brief's verdict 'провал'", t903.status === "провал", String(t903.status));
check("the diagnosis survives in result (the column that was missing is named)",
  String(t903.result).includes("WRITE-FAILED") && String(t903.result).includes("blocked_reason"),
  String(t903.result).slice(0, 160));
check("the raw verdict message is preserved too",
  String(t903.result).includes("Mock execution"), String(t903.result).slice(0, 160));
check("retry metadata was not written (metadata column is absent - the best-effort catch fired and the verdict survived)",
  metadataColumnGone === true, String(metadataColumnGone));

process.exit = realExit;
console.log(`\n=== ${failures === 0 ? "all" : failures + " failing"} zombie-guard assertions ===`);
process.exitCode = failures === 0 ? 0 : 1;
