/**
 * CLOUD-SIB-FATAL, 2026-11-05 - regression test for the S14 hang.
 *
 * The reported defect: task 155 failed with AUTH 401 and became 'провал';
 * its SIB descendants 156/157 waited forever in 'ожидает' because the
 * sibling-order guard only ever accepted a predecessor in 'готова'.
 * One auth error froze an entire triage-split tree with no record of why.
 *
 * The fix: blockDependentSiblings() - WRITES. When a triage-split subtask
 * dies a TERMINAL death, the still-waiting tail of its sibling tree is
 * switched to 'отменена' with a recorded reason, so it neither hangs
 * forever nor runs on a broken foundation.
 *
 * RETRY-BUDGET, 2026-11-06 changed what "terminal" means: a plain 'провал'
 * is now a RETRYABLE verdict (the predecessor is expected back - most
 * likely nothing is wrong beyond a stale key), so it must NOT freeze the
 * chain. Only 'провал_фатальный', or a 'провал' whose retry budget is
 * spent, terminates. Every terminal case below therefore passes the fatal
 * verdict or the exhausted budget explicitly; tests/retry-budget.mjs
 * covers the retryable side of that boundary.
 *
 * The guard is deliberately NOT loosened: cloud_queue_contract.mjs
 * normatively requires "Sibling 2 must be rejected when prior sibling is
 * 'провал'", and that fail-closed rule is intentional. An assertion below
 * pins exactly that, so a future "just let it run" change cannot slip in.
 *
 * Cases:
 *  1. regression: the live S14 shape recovers end to end - the guard still
 *     refuses (as required), and the cascade is what terminates the tail.
 *  2. regression: a fresh terminal failure cancels only the waiting tail;
 *     already-'готова' work is never downgraded.
 *  3. negative: a paused ('ожидает' = provider sleeping) predecessor must
 *     NOT cancel its siblings - that work is merely waiting to be retried.
 *  4. negative: a non-marker task is not part of a tree - no-op.
 *
 * Same file::memory: discipline as tests/cloud_queue_contract.mjs.
 */

import { createClient } from "@libsql/client";
import { makeSiblingOrderOk } from "../scripts/sibling-parser.mjs";
import { blockDependentSiblings } from "../scripts/executor.mjs";

const MAX = 3; // MAX_TASK_RETRIES

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " :: " + extra : ""}`); }
}

const SCHEMA = `CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  status TEXT,
  text TEXT,
  result TEXT,
  blocked_reason TEXT
);`;

async function freshDb(seed) {
  const db = createClient({ url: "file::memory:" });
  await db.execute(SCHEMA);
  for (const row of seed) {
    await db.execute({
      sql: "INSERT INTO tasks (id, status, text, result, blocked_reason) VALUES (?,?,?,?,?)",
      args: [row.id, row.status, row.text, row.result ?? null, row.blocked_reason ?? null],
    });
  }
  return db;
}

// NOTE: fetch with `SELECT *` - the guard parses task.text, and a row selected
// without it fails open ("no marker"), which silently defeats the whole test.
const get = (db, id) => db.execute({ sql: "SELECT * FROM tasks WHERE id=?", args: [id] }).then((r) => r.rows[0]);

const row = (id, status, marker, result) => ({ id, status, text: `${marker} do part ${id}`, result });

const T155 = "[SIB 1/3 parent:155] do part 155";
const T156 = "[SIB 2/3 parent:155] do part 156";
const T157 = "[SIB 3/3 parent:155] do part 157";

console.log("=== CLOUD-SIB-FATAL regression tests ===\n");

// ---------------------------------------------------------------- case 1
// The live S14 shape: 155 dead with 401, 156 and 157 parked in 'ожидает'.
{
  const db = await freshDb([
    row(155, "провал", "[SIB 1/3 parent:155]", "ERR_AUTH_FAILURE: HTTP Error 401: Unauthorized"),
    row(156, "ожидает", "[SIB 2/3 parent:155]"),
    row(157, "ожидает", "[SIB 3/3 parent:155]"),
  ]);
  const order = makeSiblingOrderOk(db);

  // The guard still says no here - that is REQUIRED behavior, pinned by
  // cloud_queue_contract.mjs line 933. It only ever reads state, so on its
  // own it is precisely the pre-fix hang.
  const held = await order(await get(db, 156));
  check("guard still rejects 156 while 155 is 'провал' (fail-closed, as contracted)", held === false, `got ${held}`);

  // Production order: 155's terminal failure cascades to its waiting tail.
  // THIS is what breaks the hang - it terminates the tail instead of
  // releasing it to burn a doomed attempt on a broken foundation.
  const res = await blockDependentSiblings({ id: 155, status: "провал_фатальный", text: T155, result: "ERR_AUTH_FAILURE 401", metadata: JSON.stringify({ retry_count: MAX, retryable: false, retry_budget_exhausted: true }) }, db);
  check("cascade resolves exactly the two waiting siblings 156 and 157",
    res.resolved.length === 2 && String(res.parentId) === "155", JSON.stringify(res));

  const r156 = await get(db, 156);
  const r157 = await get(db, 157);
  check("both 156 and 157 are terminal 'отменена' (never picked again)",
    r156.status === "отменена" && r157.status === "отменена",
    `156=${r156.status} 157=${r157.status}`);
  check("both carry a blocking reason naming the dead predecessor",
    /155/.test(r156.blocked_reason || "") && /155/.test(r157.blocked_reason || ""),
    `156="${r156.blocked_reason}"`);

  check("guard STILL refuses 157 even though 156 is now terminal (fail-closed preserved)",
    (await order(r157)) === false);

  const r155 = await get(db, 155);
  check("the failed task itself keeps 'провал' (cascade does not rescue it)",
    r155.status === "провал", r155.status);
  db.close();
}

// ---------------------------------------------------------------- case 2
// A tree where an earlier sibling already succeeded. Only the waiting tail
// after the dead one may be cancelled - completed work must survive.
{
  const db = await freshDb([
    row(151, "готова", "[SIB 1/3 parent:150]", "done"),
    row(155, "провал", "[SIB 2/3 parent:150]", "ERR_AUTH_FAILURE: HTTP Error 401"),
    row(156, "ожидает", "[SIB 3/3 parent:150]"),
  ]);
  const res = await blockDependentSiblings({ id: 155, status: "провал_фатальный", text: "[SIB 2/3 parent:150] do part 155", result: "ERR_AUTH_FAILURE 401", metadata: JSON.stringify({ retry_count: MAX, retryable: false, retry_budget_exhausted: true }) }, db);

  check("cascade reports the parent it resolved", String(res.parentId) === "150", JSON.stringify(res.parentId));
  check("cascade resolved exactly the one waiting sibling", res.resolved.length === 1 && String(res.resolved[0]) === "156", JSON.stringify(res.resolved));

  const r156 = await get(db, 156);
  check("156 is now terminal 'отменена'", r156.status === "отменена", `got ${r156.status}`);
  check("156 carries a readable blocking reason", String(r156.blocked_reason).length > 20 && /155/.test(r156.blocked_reason), r156.blocked_reason);

  const r151 = await get(db, 151);
  check("already-'готова' sibling 151 is left untouched", r151.status === "готова" && !r151.blocked_reason, `${r151.status}/${r151.blocked_reason}`);

  const r155 = await get(db, 155);
  check("the failed task itself keeps 'провал'", r155.status === "провал", r155.status);
  db.close();
}

// ---------------------------------------------------------------- case 3
// Negative: paused work must survive. A provider sleeping until its quota
// reset returns the task to 'ожидает' - its siblings must keep waiting.
{
  const db = await freshDb([
    row(155, "ожидает", "[SIB 1/3 parent:155]", "rate limit pause until quota reset"),
    row(156, "ожидает", "[SIB 2/3 parent:155]"),
  ]);
  const res = await blockDependentSiblings({ id: 155, status: "ожидает", text: T155, result: "paused" }, db);
  check("paused chain: cascade resolves nothing", res.resolved.length === 0, JSON.stringify(res.resolved));

  const r156 = await get(db, 156);
  check("paused chain: 156 stays 'ожидает' and un-blocked (a real wait, not a hang)",
    r156.status === "ожидает" && !r156.blocked_reason, `${r156.status}/${r156.blocked_reason}`);

  const order = makeSiblingOrderOk(db);
  check("paused chain: guard still holds 156 back (predecessor not terminal)",
    (await order(r156)) === false);
  db.close();
}

// ---------------------------------------------------------------- case 4
// Negative: no marker at all - not part of any tree.
{
  const db = await freshDb([ row(900, "провал", "plain task text with no marker", "boom") ]);
  const res = await blockDependentSiblings({ id: 900, status: "провал_фатальный", text: "plain task text with no marker", result: "boom", metadata: JSON.stringify({ retry_count: MAX }) }, db);
  check("non-marker task: cascade is a no-op", res.parentId === null && res.resolved.length === 0, JSON.stringify(res));
  db.close();
}

// ---------------------------------------------------------------- case 5
// 2026-11-12, Plexus's architectural bug: the queue froze while a
// predecessor waited for the founder's verdict. 'ждёт_приёмки' means
// "the work is done, the human decides" - that is NOT a reason to stop
// computing. The skip set is exactly the states where the predecessor has
// stopped being work-in-progress: готово / принято / ждёт приёмки /
// просрочено / отменена. 'провал_фатальный' is deliberately NOT in it -
// it cascades instead of skipping.
{
  const SKIP = ["готова", "принята", "ждёт_приёмки", "ждёт_приёмки_просрочено", "отменена"];
  const HOLD = ["ожидает", "выполняется", "провал", "част_ично", "partial", "провал_фатальный", "не существует"];

  // 5a. the founder's own case: A waiting for acceptance, B must run.
  {
    const db = await freshDb([
      row(200, "ждёт_приёмки", "[SIB 1/2 parent:200]", "artifact ready"),
      row(201, "ожидает", "[SIB 2/2 parent:200]"),
    ]);
    const order = makeSiblingOrderOk(db);
    check("A='ждёт_приёмки' does NOT block B (no human verdict = no queue stop)",
      (await order(await get(db, 201))) === true);
    db.close();
  }

  // 5b. the whole skip set, one row per status.
  {
    const db = await freshDb(
      SKIP.map((st, i) => row(300 + i, st, `[SIB 1/2 parent:${300 + i}]`, "x"))
        .flatMap((r) => [r, row(400 + (r.id - 300), "ожидает", `[SIB 2/2 parent:${r.id}]`)])
    );
    const order = makeSiblingOrderOk(db);
    for (const st of SKIP) {
      const i = SKIP.indexOf(st);
      const ok = await order(await get(db, 400 + i));
      check(`predecessor '${st}' is a skip state - successor runs`, ok === true, `got ${ok}`);
    }
    db.close();
  }

  // 5c. the hold set is still hold - fail-closed preserved (contracted).
  {
    const db = await freshDb(
      HOLD.map((st, i) => row(500 + i, st, `[SIB 1/2 parent:${500 + i}]`, "x"))
        .flatMap((r) => [r, row(600 + (r.id - 500), "ожидает", `[SIB 2/2 parent:${r.id}]`)])
    );
    const order = makeSiblingOrderOk(db);
    for (const st of HOLD) {
      const i = HOLD.indexOf(st);
      const ok = await order(await get(db, 600 + i));
      check(`predecessor '${st}' still blocks the successor (fail-closed)`, ok === false, `got ${ok}`);
    }
    db.close();
  }

  // 5d. fatal predecessor: the guard does not skip (case 1 pattern) and the
  // cascade is what terminates the tail - prove it here, not just assert it.
  {
    const db = await freshDb([
      row(700, "провал_фатальный", "[SIB 1/2 parent:700]", "ERR_AUTH_FAILURE"),
      row(701, "ожидает", "[SIB 2/2 parent:700]"),
    ]);
    const order = makeSiblingOrderOk(db);
    check("fatal predecessor is NOT a skip state", (await order(await get(db, 701))) === false);
    const res = await blockDependentSiblings({ id: 700, status: "провал_фатальный", text: "[SIB 1/2 parent:700] do part 700", result: "ERR_AUTH_FAILURE", metadata: JSON.stringify({ retry_count: MAX, retryable: false, retry_budget_exhausted: true }) }, db);
    check("fatal cascade cancels the waiting successor", res.resolved.length === 1 && String(res.resolved[0]) === "701", JSON.stringify(res));
    const r701 = await get(db, 701);
    check("cancelled successor is 'отменена' (cascade, not skip)", r701.status === "отменена", r701.status);
    db.close();
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
