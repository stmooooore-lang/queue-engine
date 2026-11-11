// ACCEPT-AND-MERGE: the row first, then the trigger; a failed trigger is never a
// failed acceptance.
//
// The whole point of S15 is that a GitHub cron on a free account is hours of
// silence, so the immediate path is a workflow_dispatch. What must NOT happen is
// the obvious failure mode: dispatching a merge for a row that was never
// actually written. These tests pin the order and the containment, with Turso
// and GitHub both faked at the fetch boundary (the same boundary the worker and
// the CLI use).
import { acceptAndMergeTask, dispatchUrl, dispatchAcceptanceMerge, httpUrlFor, redact } from '../scripts/accept-and-merge.mjs';

const passed = [];
const failed = [];
function check(name, ok, detail) {
  if (ok) { passed.push(name); console.log(`  PASS  ${name}`); }
  else { failed.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? `\n        ${String(detail).split('\n').slice(0, 10).join('\n        ')}` : ''}`); }
}

// A fake Turso: rows are the test's, every statement is recorded with its args.
function fakeTurso(rows, updates = []) {
  const calls = [];
  let current = rows.value;
  const fetchImpl = async (url, opts) => {
    // The request body is a JSON STRING (the script stringifies it) - parse it
    // once and read from the parsed object.
    const stmt = JSON.parse(opts.body).requests[0].stmt;
    calls.push({ url, body: { sql: stmt.sql } });
    const sql = stmt.sql;
    const args = stmt.args.map((a) => a.value);
    let payload;
    if (/^SELECT/.test(sql)) {
      payload = { cols: [{ name: 'id' }, { name: 'status' }], rows: current.filter((r) => String(r.id) === String(args[0])).map((r) => [{ value: String(r.id) }, { value: r.status }]) };
    } else {
      current = current.map((r) => (String(r.id) === String(args[1]) ? { ...r, status: args[0] } : r));
      updates.push(args.slice());
      payload = { cols: [{ name: 'affected_row_count' }], rows: [[{ value: 1 }]] };
    }
    return {
      ok: true,
      json: async () => ({ results: [{ type: 'ok', response: { result: payload } }] }),
    };
  };
  return { db: { httpUrl: 'https://fake.turso.io', authToken: 'fake-token' }, fetchImpl, calls, updates, get: () => current };
}

// A fake GitHub: records the dispatch and answers whatever the test says.
function fakeGithub(status = 204, body = '') {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetchImpl, calls };
}

console.log(`[${new Date().toISOString()}] === ACCEPT-AND-MERGE: acceptance + immediate merge trigger ===`);

// 1. the happy path: row written, read back, dispatch fired.
{
  const turso = fakeTurso({ value: [{ id: 181, status: 'ждёт_приёмки' }] });
  const gh = fakeGithub(204);
  const order = [];
  const routed = (tursoFetch, githubFetch) => async (url, opts) => {
    if (String(url).includes('/v2/pipeline')) { order.push(/UPDATE/.test(opts.body) ? 'update' : 'read'); return tursoFetch(url, opts); }
    order.push('github'); return githubFetch(url, opts);
  };
  const r = await acceptAndMergeTask({ taskId: 181, db: turso.db, token: 'pat', fetchImpl: routed(turso.fetchImpl, gh.fetchImpl) });
  check('A1 an accepted task triggers the merge immediately',
    r.ok === true && r.dispatched === true && r.code === 'ACCEPTED', JSON.stringify(r));
  check('A2 ...after the row actually read back as принята',
    turso.updates.length === 1 && turso.updates[0][0] === 'принята' && turso.get()[0].status === 'принята',
    JSON.stringify(turso.updates));
  check('A3 ...and the dispatch went to the right endpoint with the right body',
    gh.calls.length === 1 && gh.calls[0].url === 'https://api.github.com/repos/stmooooore-lang/queue-engine/actions/workflows/merge-pending.yml/dispatches' && gh.calls[0].body.ref === 'main',
    JSON.stringify(gh.calls));
  // read + UPDATE + read-back: three Turso statements, and the dispatch is the
  // LAST step of all (ordering, not just count).
  check('A4 ...and the dispatch happened AFTER the write, not before',
    turso.calls.length === 3 && turso.calls.map((c) => c.body.sql).filter((s) => /UPDATE/.test(s)).length === 1
      && gh.calls.length === 1 && order[order.length - 1] === 'github'
      && order.slice(0, order.indexOf('github')).includes('update'),
    `steps=${JSON.stringify(order)} turso=${turso.calls.length}`);
}

// 2. a dispatch that fails must not undo the acceptance (cron is the fallback).
for (const [label, status, body] of [['HTTP 401', 401, 'Bad credentials'], ['HTTP 422', 422, 'Workflow does not exist'], ['network down', 0, 'fetch failed']]) {
  const turso = fakeTurso({ value: [{ id: 181, status: 'ждёт_приёмки_просрочено' }] });
  const gh = fakeGithub(status, body);
  const r = await acceptAndMergeTask({ taskId: 181, db: turso.db, token: 'pat', fetchImpl: combined(turso.fetchImpl, gh.fetchImpl) });
  check(`A5 [${label}] the acceptance still stands (cron is the fallback)`,
    r.ok === true && r.dispatched === false && turso.get()[0].status === 'принята' && turso.updates.length === 1,
    `${JSON.stringify(r)} updates=${JSON.stringify(turso.updates)}`);
  check(`A6 [${label}] ...and the reason names the fallback explicitly`,
    /cron/.test(r.reason || '') && /dispatch did not fire|fallback/.test(r.reason || ''), r.reason);
}

// 3. without a token: accepted, no dispatch, no crash.
{
  const turso = fakeTurso({ value: [{ id: 181, status: 'ждёт_приёмки' }] });
  const gh = fakeGithub(204);
  const r = await acceptAndMergeTask({ taskId: 181, db: turso.db, token: undefined, fetchImpl: combined(turso.fetchImpl, gh.fetchImpl) });
  check('A7 without a dispatch token the row is still accepted',
    r.ok === true && r.dispatched === false && turso.get()[0].status === 'принята', JSON.stringify(r));
  check('A8 ...and nothing was dispatched at all',
    gh.calls.length === 0, JSON.stringify(gh.calls));
}

// 4. a failed write must stop BEFORE the dispatch.
{
  const turso = fakeTurso({ value: [{ id: 181, status: 'ждёт_приёмки' }] });
  const gh = fakeGithub(204);
  const broken = async (url, opts) => (String(opts.body).includes('UPDATE') ? { ok: false, status: 500, text: async () => 'db down' } : turso.fetchImpl(url, opts));
  const r = await acceptAndMergeTask({ taskId: 181, db: turso.db, token: 'pat', fetchImpl: combined(broken, gh.fetchImpl) });
  check('A9 an unwritable row dispatches NOTHING (fail closed)',
    r.ok === false && r.code === 'WRITE-FAILED' && gh.calls.length === 0 && turso.updates.length === 0,
    `${JSON.stringify(r)} dispatches=${gh.calls.length}`);
}

// 5. an UPDATE that reports success but changes nothing (read-back guard).
{
  const turso = fakeTurso({ value: [{ id: 181, status: 'ждёт_приёмки' }] });
  const gh = fakeGithub(204);
  // rows come back unchanged, no matter what the UPDATE claimed
  const lying = async (url, opts) => {
    const res = await turso.fetchImpl(url, opts);
    return { ...res, json: async () => ({ results: [{ type: 'ok', response: { result: { cols: [{ name: 'id' }, { name: 'status' }], rows: [[{ value: '181' }, { value: 'ждёт_приёмки' }]], affected_row_count: 1 } } }] }) };
  };
  const r = await acceptAndMergeTask({ taskId: 181, db: turso.db, token: 'pat', fetchImpl: combined(lying, gh.fetchImpl) });
  check('A10 an UPDATE that did not take effect dispatches NOTHING',
    r.ok === false && r.code === 'WRITE-FAILED' && gh.calls.length === 0,
    `${JSON.stringify(r)} dispatches=${gh.calls.length}`);
}

// 6. states acceptance must not touch.
{
  const turso = fakeTurso({ value: [{ id: 181, status: 'выполняется' }] });
  const gh = fakeGithub(204);
  const r = await acceptAndMergeTask({ taskId: 181, db: turso.db, token: 'pat', fetchImpl: combined(turso.fetchImpl, gh.fetchImpl) });
  check('A11 a task still running is not accepted (a pass is mid-flight)',
    r.ok === false && r.code === 'NOT-ACCEPTABLE' && gh.calls.length === 0 && turso.updates.length === 0,
    `${JSON.stringify(r)} dispatches=${gh.calls.length}`);
}
{
  const turso = fakeTurso({ value: [{ id: 181, status: 'готова' }] });
  const gh = fakeGithub(204);
  const r = await acceptAndMergeTask({ taskId: 181, db: turso.db, token: 'pat', fetchImpl: combined(turso.fetchImpl, gh.fetchImpl) });
  check('A12 an already-published task is a no-op, not a second merge',
    r.ok === true && r.code === 'ALREADY-DONE' && r.dispatched === false && turso.updates.length === 0 && gh.calls.length === 0,
    `${JSON.stringify(r)} updates=${JSON.stringify(turso.updates)}`);
}
{
  const turso = fakeTurso({ value: [] });
  const gh = fakeGithub(204);
  const r = await acceptAndMergeTask({ taskId: 999, db: turso.db, token: 'pat', fetchImpl: combined(turso.fetchImpl, gh.fetchImpl) });
  check('A13 a task that does not exist is named, not silently ignored',
    r.ok === false && r.code === 'TASK-NOT-FOUND' && gh.calls.length === 0, JSON.stringify(r));
}

// 7. idempotence: pressing accept twice does not dispatch twice by mistake, and
//    a second press on 'принята' still fires the merge (the cron may be behind).
{
  const turso = fakeTurso({ value: [{ id: 181, status: 'принята' }] });
  const gh = fakeGithub(204);
  const r = await acceptAndMergeTask({ taskId: 181, db: turso.db, token: 'pat', fetchImpl: combined(turso.fetchImpl, gh.fetchImpl) });
  check('A14 a second accept on an accepted row re-triggers the merge',
    r.ok === true && r.dispatched === true && turso.updates.length === 0, `${JSON.stringify(r)} updates=${JSON.stringify(turso.updates)}`);
}

// 8. helpers: no token, no URL nonsense, and no credential in output.
{
  const gh = fakeGithub(401, 'Bad credentials');
  const r = await dispatchAcceptanceMerge(undefined, 'stmooooore-lang/queue-engine', gh.fetchImpl);
  check('A15 without a token the dispatch reports why, quietly',
    r.ok === false && /GITHUB_DISPATCH_TOKEN is not set/.test(r.reason) && gh.calls.length === 0, r.reason);
}
{
  const gh = fakeGithub(401, 'Bad credentials');
  const r = await dispatchAcceptanceMerge('pat', 'stmooooore-lang/queue-engine', gh.fetchImpl);
  check('A16 a token never appears in a failure reason',
    r.ok === false && !r.reason.includes('pat'), r.reason);
}
check('A17 the libsql URL is converted to https for /v2/pipeline',
  httpUrlFor('libsql://queue-xyz.turso.io') === 'https://queue-xyz.turso.io' && httpUrlFor('https://already-https.turso.io') === 'https://already-https.turso.io',
  httpUrlFor('libsql://queue-xyz.turso.io'));
check('A18 credentials are masked in anything that reaches a log',
  /MASKED/.test(redact('Authorization: Bearer ghp_liveTokenValue12345 token=supersecretvalue')) && redact('Authorization: Bearer ghp_liveTokenValue12345 token=supersecretvalue').indexOf('ghp_live') === -1,
  redact('Authorization: Bearer ghp_liveTokenValue12345 token=supersecretvalue'));
check('A19 the dispatch target can be repointed at another repo',
  dispatchUrl('stmooooore-lang/yp') === 'https://api.github.com/repos/stmooooore-lang/yp/actions/workflows/merge-pending.yml/dispatches',
  dispatchUrl('stmooooore-lang/yp'));

// Route Turso and GitHub through one fetch: the URL decides who answers.
function combined(tursoFetch, githubFetch) {
  return async (url, opts) => (String(url).includes('/v2/pipeline') ? tursoFetch(url, opts) : githubFetch(url, opts));
}

console.log(`[${new Date().toISOString()}] === ${passed.length} passed, ${failed.length} failed ===`);
for (const f of failed) console.log(`  FAIL  ${f.name}\n        ${String(f.detail).split('\n').slice(0, 12).join('\n        ')}`);
process.exit(failed.length ? 1 : 0);
