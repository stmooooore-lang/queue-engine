#!/usr/bin/env node
// ACCEPTANCE-GATE: which tasks are waiting for a merge?
//
//   node scripts/list-accepted-pending.mjs
//
// Prints one TSV line per accepted task: id <tab> target_branch. This is the
// selection half of merge-pending.yml ("найти задачи со статусом 'принята' и
// pending_branch"); the merge half is scripts/accept-pending.mjs.
//
// Selection is explicit rather than "anything not 'готова'": a task is mergeable
// when the FOUNDER said 'принята' AND the executor recorded where it preserved
// the work (metadata.pending_branch). One without the other is not actionable,
// and printing it would make the workflow fail on a row it cannot act on.
import { createClient } from "@libsql/client";

const ACCEPTED_STATUS = "принята";

/** Same masking rule as accept-pending.mjs: nothing credential-shaped reaches a log. */
export function redact(text) {
  return String(text == null ? "" : text)
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1***MASKED***")
    .replace(/(token|key|secret|password|authToken)\s*[:=]\s*\S+/gi, "$1=***MASKED***")
    .replace(/(Bearer)\s+\S+/gi, "$1 ***MASKED***")
    .replace(/\b(sk|gsk|glsa|libsql|eyJ)[A-Za-z0-9._-]{8,}/g, "$1***MASKED***");
}

function tursoClientFromEnv(env = process.env) {
  const url = env.TURSO_DATABASE_URL || env.TURSO_URL;
  const authToken = env.TURSO_AUTH_TOKEN || env.TURSO_TOKEN;
  if (!url || !authToken) {
    console.error(redact("NO-TURSO-CREDENTIALS: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (or TURSO_URL / TURSO_TOKEN)"));
    process.exit(7);
  }
  return createClient({ url: String(url).replace(/^libsql:\/\//, "https://"), authToken });
}

export async function selectAcceptedPending(client) {
  const res = await client.execute({
    sql: `SELECT id, metadata FROM tasks WHERE status = ? ORDER BY id ASC`,
    args: [ACCEPTED_STATUS],
  });
  const rows = res && res.rows ? res.rows : [];
  const out = [];
  for (const row of rows) {
    let metadata = {};
    try { metadata = row.metadata ? (typeof row.metadata === "object" ? row.metadata : JSON.parse(row.metadata)) : {}; }
    catch { metadata = {}; }
    const pending = metadata && metadata.pending_branch;
    const branch = (metadata && metadata.target_branch) || "main";
    if (typeof pending === "string" && pending.length > 0) out.push({ id: Number(row.id), targetBranch: String(branch), pendingBranch: pending });
  }
  return out;
}

const client = tursoClientFromEnv();
const rows = await selectAcceptedPending(client);
for (const row of rows) console.log(`${row.id}\t${row.targetBranch}`);
