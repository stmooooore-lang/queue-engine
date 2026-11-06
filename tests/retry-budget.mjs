/**
 * RETRY-BUDGET, 2026-11-06 - regression test for transient-vs-fatal retries.
 *
 * The founder's brief, exactly:
 *   transient (401, 429, timeouts, ECONNRESET) -> 'провал' + retry_count,
 *     and the dispatcher re-picks it after 5 minutes while retry_count < 3
 *   fatal (syntax, invalid model, logic) -> 'провал_фатальный', and the SIB
 *     cascade fires on it
 *
 * What is asserted here:
 *   A. classifyFailure(): the whole transient and fatal taxonomy.
 *   B. isRetryableFailureTask(): the SHARED rule both contours use, including
 *      the budget being authoritative over the flag (a row written while the
 *      count was 1 must not stay "retryable" forever).
 *   C. the dispatcher's own SELECT, run against a real in-memory table, so
 *      the SQL filtering (retry budget + the 5-minute gate + JSON safety) is
 *      verified rather than assumed.
 *   D. the SIB cascade boundary: a retryable 'провал' must NOT freeze its
 *      chain, while 'провал_фатальный' must. This is the reconciliation that
 *      keeps run 41958012870 from re-freezing task 157 after its 401 retry.
 */

import { createClient } from "@libsql/client";
import { classifyFailure, isRetryableFailureTask, blockDependentSiblings } from "../scripts/executor.mjs";
import { DISPATCH_SELECT_SQL } from "../scripts/dispatcher.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " :: " + extra : ""}`); }
}

const T = (message, category, extra = {}) => ({ success: false, message, category, ...extra });

console.log("=== RETRY-BUDGET regression tests ===\n");

// ------------------------------------------------------------------ A
console.log("--- A. classification ---");
check("401 Invalid API Key -> retryable", classifyFailure(T('dsh: AUTH: 401: "Invalid API Key","code":"invalid_api_key"', "auth")).retryable === true);
check("429 Too Many Requests -> retryable", classifyFailure(T("HTTP Error 429: Too Many Requests", "capacity")).retryable === true);
check("dsh timed out after 20min -> retryable", classifyFailure(T("dsh timed out after 20min", "timeout")).retryable === true);
check("ECONNRESET with no category -> retryable", classifyFailure(T("read ECONNRESET", null)).retryable === true);
check("ECONNABORTED -> retryable", classifyFailure(T("socket hang up / ECONNABORTED", null)).retryable === true);
check("503 service unavailable -> retryable", classifyFailure(T("503 Service Unavailable", "capacity")).retryable === true);
check("invalid model -> FATAL", classifyFailure(T("UNKNOWN_MODEL: not a valid model", "process")).fatal === true);
check("a permanent block is NOT folded into the fatal verdict (three meanings for one defect)",
  classifyFailure({ success: false, message: "no_address", permanent: true }).fatal === false);
check("MODULE_NOT_FOUND -> FATAL", classifyFailure(T("Cannot find module ...", "process")).fatal === true);
check("SyntaxError -> FATAL", classifyFailure(T("SyntaxError: unexpected token }", "process")).fatal === true);
check("no_address permanent block -> NEITHER retryable nor fatal: it keeps its own blocked_reason axis",
  (() => { const c = classifyFailure({ success: false, message: "no_address", permanent: true }); return c.retryable === false && c.fatal === false; })());
check("403 + permanent_blocker hint -> NEITHER: a credential wall is not a task defect either",
  (() => { const c = classifyFailure(T("403 forbidden", "auth", { recoveryHint: "permanent_blocker" })); return c.retryable === false && c.fatal === false; })());
check("impossible_as_written -> FATAL", classifyFailure(T("brief is impossible_as_written", "unknown")).fatal === true);
check("success -> no verdict at all", classifyFailure({ success: true }).retryable === false && classifyFailure({ success: true }).fatal === false);
check("no failure object -> no verdict", classifyFailure(null).fatal === false && classifyFailure(null).retryable === false);

// ------------------------------------------------------------------ B
console.log("\n--- B. shared retryable rule ---");
const row = (m, b = null) => ({ status: "провал", metadata: m === null ? null : JSON.stringify(m), blocked_reason: b });
const epoch = (offsetSec) => Math.floor(Date.now() / 1000) - offsetSec;

check("retry_count=1, retryable -> retryable", isRetryableFailureTask(row({ retry_count: 1, retryable: true })) === true);
check("retry_count=3 -> NOT retryable (budget spent, founder's <3 rule)",
  isRetryableFailureTask(row({ retry_count: 3, retryable: true })) === false);
check("retry_count=2 (last attempt) -> retryable",
  isRetryableFailureTask(row({ retry_count: 2, retryable: true })) === true);
check("retry_count=5 -> NOT retryable",
  isRetryableFailureTask(row({ retry_count: 5, retryable: true })) === false);
check("retryable:false -> NOT retryable", isRetryableFailureTask(row({ retry_count: 1, retryable: false })) === false);
check("blocked_reason set -> NOT retryable (founder-fixable block)",
  isRetryableFailureTask(row({ retry_count: 1, retryable: true }, "no_address")) === false);
check("legacy 'провал' with no metadata -> NOT retryable (no failed_at, so the founder's 5-minute gate cannot be evaluated)",
  isRetryableFailureTask(row(null)) === false);
check("broken JSON metadata -> NOT retryable, and must not throw",
  isRetryableFailureTask({ status: "провал", metadata: "not json at all", blocked_reason: null }) === false);
check("'ожидает' is not a failure task", isRetryableFailureTask({ status: "ожидает", metadata: null }) === false);
check("'провал_фатальный' is not retryable by this rule (it is never 'провал')",
  isRetryableFailureTask({ status: "провал_фатальный", metadata: null }) === false);

// ------------------------------------------------------------------ C
console.log("\n--- C. dispatcher SELECT (real in-memory table) ---");
const db = createClient({ url: "file::memory:" });
await db.execute(`CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, status TEXT, text TEXT, metadata TEXT,
  blocked_reason TEXT, paused_until TEXT
);`);
const ins = (id, status, meta, blocked = null, paused = null) =>
  db.execute({ sql: "INSERT INTO tasks VALUES (?,?,?,?,?,?)", args: [id, status, `[SIB 1/2 parent:${id}] x`, meta === null ? null : JSON.stringify(meta), blocked, paused] });

ins(1, "ожидает", null);                                                        // fresh work
ins(2, "провал", null);                                                         // legacy, no metadata
ins(3, "провал", { retry_count: 1, failed_at: epoch(600) });                     // 10 min ago, fresh budget
ins(4, "провал", { retry_count: 1, failed_at: epoch(10) });                      // 10s ago - inside the 5-min gate
ins(5, "провал", { retry_count: 3, failed_at: epoch(600) });                     // budget spent
ins(6, "провал", { retry_count: 1, failed_at: epoch(600) }, "founder_fixable");  // founder-fixable block
ins(7, "провал", { retry_count: 1, failed_at: epoch(600) }, null, "2099-01-01");  // paused
ins(8, "провал_фатальный", null);                                               // terminal, must stay out
await db.execute({ sql: "INSERT INTO tasks VALUES (9,'провал','not json',NULL,NULL,NULL)" }); // must not throw

const picked = (await db.execute({ sql: DISPATCH_SELECT_SQL })).rows.map((r) => Number(r.id));

check("dispatcher picks fresh work + aged retry ONLY (legacy провал без failed_at excluded)",
  JSON.stringify(picked) === JSON.stringify([1, 3]), JSON.stringify(picked));
check("a failure inside the 5-minute gate is NOT picked (id 4)", !picked.includes(4));
check("a spent budget is NOT picked (id 5)", !picked.includes(5));
check("a founder-fixable block is NOT picked (id 6)", !picked.includes(6));
check("a paused task is NOT picked (id 7)", !picked.includes(7));
check("'провал_фатальный' is NEVER picked (id 8)", !picked.includes(8));
check("legacy провал without failed_at is NOT picked (ids 2 and 9)", !picked.includes(2) && !picked.includes(9), JSON.stringify(picked));
db.close();

// ------------------------------------------------------------------ D
console.log("\n--- D. cascade boundary: retryable must NOT freeze the chain ---");
const db2 = createClient({ url: "file::memory:" });
await db2.execute(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, text TEXT, result TEXT, blocked_reason TEXT);`);
await db2.execute({ sql: "INSERT INTO tasks VALUES (1,'ожидает','[SIB 1/3 parent:1] a',NULL,NULL)" });
await db2.execute({ sql: "INSERT INTO tasks VALUES (2,'ожидает','[SIB 2/3 parent:1] b',NULL,NULL)" });
await db2.execute({ sql: "INSERT INTO tasks VALUES (3,'ожидает','[SIB 3/3 parent:1] c',NULL,NULL)" });

// a retryable провал (the groq 401 shape from run 41958012870)
const retryable = await blockDependentSiblings({
  id: 1, status: "провал", text: "[SIB 1/3 parent:1] a",
  result: 'dsh: AUTH: 401: "Invalid API Key" invalid_api_key',
  metadata: JSON.stringify({ retry_count: 1, retryable: true, failed_at: epoch(10) }),
}, db2);
check("retryable 'провал' cancels NOTHING - the chain keeps waiting for its retry",
  retryable.resolved.length === 0, JSON.stringify(retryable.resolved));
const s2 = (await db2.execute({ sql: "SELECT status FROM tasks WHERE id=2" })).rows[0];
check("sibling 2 is still 'ожидает' and un-blocked", s2.status === "ожидает" && !s2.blocked_reason, s2.status);

// the same task with a spent budget -> terminal now
const exhausted = await blockDependentSiblings({
  id: 1, status: "провал_фатальный", text: "[SIB 1/3 parent:1] a",
  result: 'dsh: AUTH: 401: "Invalid API Key" invalid_api_key (3 attempts)',
  metadata: JSON.stringify({ retry_count: 3, retryable: false, retry_budget_exhausted: true, failed_at: epoch(600) }),
}, db2);
check("spent budget / fatal verdict cancels BOTH waiting siblings",
  exhausted.resolved.length === 2, JSON.stringify(exhausted.resolved));
const final2 = (await db2.execute({ sql: "SELECT status, blocked_reason FROM tasks WHERE id=2" })).rows[0];
const final3 = (await db2.execute({ sql: "SELECT status FROM tasks WHERE id=3" })).rows[0];
check("both siblings terminate as 'отменена' with a reason",
  final2.status === "отменена" && String(final2.blocked_reason).length > 20 && final3.status === "отменена",
  `2=${final2.status} 3=${final3.status}`);
check("the reason records the retry bookkeeping",
  /попыток: 3/.test(String(final2.blocked_reason)), final2.blocked_reason);

// a legacy 'провал' row with no metadata is treated as terminal? No: unspent
// budget -> the chain keeps waiting. The opposite would freeze a whole tree
// on one transient failure, which is the bug being fixed.
const legacy = await blockDependentSiblings({
  id: 1, status: "провал", text: "[SIB 1/3 parent:1] a", result: "old failure", metadata: null,
}, db2);
check("a legacy 'провал' keeps the chain waiting too (no failed_at -> not a terminal verdict)",
  legacy.resolved.length === 0, JSON.stringify(legacy.resolved));
db2.close();

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
