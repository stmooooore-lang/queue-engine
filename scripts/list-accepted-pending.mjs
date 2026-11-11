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
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    const namedTarget = metadata && metadata.target_branch;
    const branch = namedTarget || "main";
    // 2026-11-11: a preserved violation whose head was DETACHED has no target
    // branch at all (nothing to merge into - the work was never on a branch),
    // and it is recorded with target_branch = "". Selecting it anyway would
    // default it to "main" and publish the work into the very branch the
    // violation was about, so an EMPTY recorded target means "not recorded,
    // a human must name it" and the row is skipped. A `task/<N>` target IS
    // still selected: accept-pending.mjs retires it (verifies and deletes)
    // instead of merging it.
    const targetRecorded = typeof namedTarget === "string" && namedTarget.trim().length > 0;
    if (typeof pending === "string" && pending.length > 0 && targetRecorded && /^[A-Za-z0-9._\/-]+$/.test(String(branch))) {
      out.push({ id: Number(row.id), targetBranch: String(branch), pendingBranch: pending });
    }
  }
  return out;
}

// Only run as a program, never on import - the same guard
// scripts/accept-and-merge.mjs needed, for the same reason: this checkout's path
// contains spaces (import.meta.url percent-encodes them), so comparing argv[1]
// against import.meta.url as a string silently fails and the module then either
// does nothing while exiting 0 or, here, calls process.exit(7) the moment a test
// imports it. Compare through fileURLToPath instead.
const invokedFrom = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFrom === fileURLToPath(import.meta.url)) {
  const client = tursoClientFromEnv();
  const rows = await selectAcceptedPending(client);
  for (const row of rows) console.log(`${row.id}\t${row.targetBranch}`);
}
