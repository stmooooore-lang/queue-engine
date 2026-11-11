#!/usr/bin/env node
// ACCEPTANCE-GATE: accept a task NOW and trigger the merge immediately.
//
//   node scripts/accept-and-merge.mjs <taskId>
//
// Why this exists (blocker S15, 2026-11-11): the cron in merge-pending.yml is
// the fallback, and a GitHub cron on a free account is NOT a timer - it runs
// when GitHub feels like it, which in practice means hours of silence after a
// period of repository inactivity. A founder who presses "accept" and then waits
// hours for a merge is being ignored by infrastructure, and that is exactly the
// class of bug this gate exists to remove.
//
// So the immediate path is a workflow_dispatch: this script sets the row to
// 'принята' and immediately kicks
// .github/workflows/merge-pending.yml through GitHub's REST API. The cron stays
// as the fallback for when the dispatch cannot fire (no token, API down, the
// run was skipped) - two independent triggers for one job, no silent gap.
//
// Order matters: the row is written FIRST and verified by read-back, and only
// then is the workflow dispatched. A dispatch for a row that is not actually
// 'принята' would publish unaccepted work; a dispatch that fails must not undo
// the acceptance, because the cron still owes the merge.
//
// Runs both as a Node CLI and inside the Cloudflare Worker (`/accept <id>`):
// no Node-only imports, every remote call is plain fetch - Turso over
// /v2/pipeline, GitHub's REST API for the dispatch.

const ACCEPTED_STATUS = 'принята';
const DONE_STATUS = 'готова';
const DEFAULT_REPO = 'stmooooore-lang/queue-engine';

/** Mask anything credential-shaped before it reaches a log, a reply or a report. */
export function redact(text) {
  return String(text == null ? '' : text)
    .replace(/(authorization\s*[:=]\s*)\S+/gi, '$1***MASKED***')
    .replace(/(token|key|secret|password|authToken)\s*[:=]\s*\S+/gi, '$1=***MASKED***')
    .replace(/(Bearer)\s+\S+/gi, '$1 ***MASKED***')
    .replace(/\b(sk|gsk|glsa|libsql|github_pat|ghp_|eyJ)[A-Za-z0-9._-]{8,}/g, '$1***MASKED***');
}

/**
 * libsql:// is the pipe protocol; the HTTP endpoint is what both a local Node
 * process and a Worker can reach.
 */
export function httpUrlFor(dbUrl) {
  return String(dbUrl || '').replace(/^libsql:\/\//, 'https://').replace(/^wss?:\/\//, 'https://');
}

function tursoArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number' && Number.isInteger(v)) return { type: 'integer', value: String(v) };
  if (typeof v === 'number') return { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}

/** One statement against Turso's HTTP pipeline. Dependency-free on purpose. */
export async function tursoExecute(db, sql, args = [], fetchImpl = fetch) {
  const res = await fetchImpl(`${db.httpUrl}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${db.authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(tursoArg) } }, { type: 'close' }] }),
  });
  if (!res.ok) throw new Error(`turso ${res.status}: ${redact(await res.text())}`);
  const data = await res.json();
  const first = data.results && data.results[0];
  if (!first || first.type === 'error') throw new Error(`turso: ${redact(first && first.error ? first.error.message : 'no result')}`);
  const result = first.response.result;
  const names = (result.cols || []).map((c) => c.name);
  return {
    rows: (result.rows || []).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ? row[i].value : null]))),
    rowsAffected: result.affected_row_count,
  };
}

/** The workflow_dispatch endpoint for the acceptance merge of one repo. */
export function dispatchUrl(repo = DEFAULT_REPO) {
  return `https://api.github.com/repos/${repo}/actions/workflows/merge-pending.yml/dispatches`;
}

/**
 * Kick merge-pending.yml. Never throws: a dispatch that fails is a warning,
 * because the cron still owes the merge. The GitHub error body is truncated -
 * an API error page is not a place to discover a token.
 */
export async function dispatchAcceptanceMerge(token, repo = DEFAULT_REPO, fetchImpl = fetch) {
  if (!token) {
    return { ok: false, reason: 'GITHUB_DISPATCH_TOKEN is not set - the row is accepted and the cron will merge it' };
  }
  try {
    const res = await fetchImpl(dispatchUrl(repo), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'queue-engine-accept-and-merge',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.text()).slice(0, 300);
    return { ok: false, reason: `github ${res.status}: ${redact(body)}` };
  } catch (err) {
    return { ok: false, reason: redact(err.message) };
  }
}

/**
 * Accept one task and trigger its merge.
 *
 * Returns { ok, code, reason, dispatched }:
 *   ACCEPTED        - the row was written (or already said 'принята')
 *   ALREADY-DONE    - the row is 'готова' already: nothing to accept, nothing
 *                     dispatched (the executor published it itself)
 *   TASK-NOT-FOUND  - no such row
 *   NOT-ACCEPTABLE  - the row is in a state acceptance must not touch
 *                     ('выполняется' means a pass is still running; overwriting
 *                     it would publish a verdict for work nobody has finished)
 *   WRITE-FAILED    - the status could not be written: no dispatch happens,
 *                     because dispatching a merge for a row that is not
 *                     'принята' is publishing unaccepted work
 */
export async function acceptAndMergeTask({
  taskId, db, token, repo = DEFAULT_REPO, fetchImpl = fetch, log = (m) => console.log(`[${new Date().toISOString()}] accept-and-merge ${redact(m)}`),
}) {
  const read = async () => (await tursoExecute(db, 'SELECT id, status FROM tasks WHERE id = ?', [taskId], fetchImpl)).rows[0];
  let row;
  try { row = await read(); }
  catch (err) { return { ok: false, code: 'TURSO-UNREADABLE', reason: String(err.message), dispatched: false }; }
  if (!row) return { ok: false, code: 'TASK-NOT-FOUND', reason: `task ${taskId}: no such row in Turso`, dispatched: false };
  if (row.status === DONE_STATUS) {
    log(`task ${taskId} is already '${DONE_STATUS}' - nothing to accept, nothing to dispatch`);
    return { ok: true, code: 'ALREADY-DONE', reason: `task ${taskId} is already '${DONE_STATUS}'`, dispatched: false, status: row.status };
  }
  if (row.status === 'выполняется') {
    return { ok: false, code: 'NOT-ACCEPTABLE', reason: `task ${taskId} is 'выполняется' - a pass is still running; accepting before it parks would publish a verdict for unfinished work`, dispatched: false };
  }

  let written = 0;
  if (row.status !== ACCEPTED_STATUS) {
    try {
      // The founder's decision, written first: everything downstream reads it.
      const wrote = await tursoExecute(db, 'UPDATE tasks SET status = ? WHERE id = ?', [ACCEPTED_STATUS, taskId], fetchImpl);
      written = wrote.rowsAffected;
    } catch (err) {
      return { ok: false, code: 'WRITE-FAILED', reason: `the row could not be set to '${ACCEPTED_STATUS}': ${err.message} - no dispatch happens, because a merge without a written verdict would publish unaccepted work`, dispatched: false };
    }
    // Read it back: an UPDATE that reports success and changes nothing (row
    // locked, wrong id, a race with the pass writing its own verdict) must not
    // be treated as a decision that was made.
    try {
      const after = await read();
      if (!after || after.status !== ACCEPTED_STATUS) {
        return { ok: false, code: 'WRITE-FAILED', reason: `the row did not read back as '${ACCEPTED_STATUS}' (it reads '${after ? after.status : 'missing'}') - no dispatch happens`, dispatched: false };
      }
    } catch (err) {
      return { ok: false, code: 'WRITE-FAILED', reason: `the write could not be verified: ${err.message} - no dispatch happens`, dispatched: false };
    }
    log(`task ${taskId}: ${row.status} -> '${ACCEPTED_STATUS}' (rows affected: ${written})`);
  } else {
    log(`task ${taskId} already says '${ACCEPTED_STATUS}' - dispatching the merge anyway`);
  }

  const dispatched = await dispatchAcceptanceMerge(token, repo, fetchImpl);
  if (dispatched.ok) {
    log(`task ${taskId}: merge-pending.yml dispatched to ${repo} (cron remains the fallback)`);
    return { ok: true, code: row.status === ACCEPTED_STATUS ? 'ALREADY-ACCEPTED' : 'ACCEPTED', reason: `task ${taskId} accepted and the merge workflow was triggered`, dispatched: true };
  }
  // Containment: the acceptance stands, the merge is owed by the cron. Never a
  // hard failure - a failed dispatch must not look like a failed acceptance.
  log(`WARNING: task ${taskId} is accepted, but the immediate dispatch did not fire (${dispatched.reason}) - the */5 cron is the fallback`);
  return { ok: true, code: 'ACCEPTED-NO-DISPATCH', reason: `task ${taskId} accepted; the immediate merge trigger did not fire (${dispatched.reason}) - the cron remains the fallback`, dispatched: false, dispatchReason: dispatched.reason };
}

function usage() {
  console.error('usage: node scripts/accept-and-merge.mjs <taskId>');
  console.error('  env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, GITHUB_DISPATCH_TOKEN (optional: GITHUB_REPOSITORY / ACCEPT_MERGE_REPO)');
}

async function main(argv, env = process.env) {
  const taskIdArg = argv[0];
  const taskId = Number(taskIdArg);
  if (!taskIdArg || !Number.isInteger(taskId) || taskId <= 0) { usage(); return 2; }
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    console.error(redact('NO-TURSO-CREDENTIALS: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN'));
    return 7;
  }
  const db = { httpUrl: httpUrlFor(env.TURSO_DATABASE_URL), authToken: env.TURSO_AUTH_TOKEN };
  const repo = env.ACCEPT_MERGE_REPO || env.GITHUB_REPOSITORY || DEFAULT_REPO;
  try {
    const result = await acceptAndMergeTask({
      taskId, db, token: env.GITHUB_DISPATCH_TOKEN, repo,
    });
    if (result.ok) {
      console.log(`OK [${result.code}]: ${result.reason}`);
      return 0;
    }
    console.log(`FAILED [${result.code}]: ${result.reason}`);
    return 1;
  } catch (err) {
    console.log(`FAILED [UNEXPECTED]: ${redact(err.stack || err.message)}`);
    return 1;
  }
}

// Only run as a program, never on import - tests and the Worker import these.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
