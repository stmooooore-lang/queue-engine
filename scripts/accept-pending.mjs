#!/usr/bin/env node
// ACCEPTANCE-GATE: accept an overdue task.
//
//   node scripts/accept-pending.mjs <taskId> <targetRepoPath> <targetBranch> [pendingBranch]
//
// The founder's ONLY action is setting the task row to 'принята' in Turso. This
// script is what happens next: it fetches the preserved `pending/task-<id>` ref,
// merges it into the target branch with a visible merge node, pushes, deletes the
// pending ref, and closes the row as 'готова'. Nothing is pushed before the
// decision - that is the whole gate, and this script never widens it.
//
// The spec this implements: docs/ACCEPTANCE-GATE-SPEC.md. Every repo that uses
// queue-engine copies this script and .github/workflows/merge-pending.yml.
//
// Exit codes are the contract (see the FAIL* constants below), so a caller -
// workflow or human - can tell a conflict from a missing decision without
// parsing prose. A non-zero exit NEVER leaves the target branch pushed and the
// row closed at the same time: the row is closed only after the push is verified
// against origin.
import fs from "node:fs";
import { execSync } from "node:child_process";
import { createClient } from "@libsql/client";

const ACCEPTED_STATUS = "принята";
const DONE_STATUS = "готова";
const DEFAULT_PENDING_PREFIX = "pending/task-";

// Exit codes. Distinct on purpose: CI needs "is this a conflict?" without a
// human reading the log.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_NOT_ACCEPTED = 2;    // the decision has not been made (or was revoked)
const EXIT_WORKDIR_DIRTY = 3;   // uncommitted work in the target repo
const EXIT_CONFLICT = 4;        // MERGE-CONFLICT - nothing pushed, see the log
const EXIT_PUSH_NOT_VERIFIED = 5;
const EXIT_NOT_READY = 3;         // 'принята' but nothing preserved yet - retry, do not fail
const EXIT_TASK_NOT_FOUND = 6;
const EXIT_NO_CREDENTIALS = 7;

/** Mask anything that looks like a credential before it reaches a log or a report. */
export function redact(text) {
  return String(text == null ? "" : text)
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1***MASKED***")
    .replace(/(token|key|secret|password|authToken)\s*[:=]\s*\S+/gi, "$1=***MASKED***")
    .replace(/(Bearer)\s+\S+/gi, "$1 ***MASKED***")
    .replace(/\b(sk|gsk|glsa|libsql|eyJ)[A-Za-z0-9._-]{8,}/g, "$1***MASKED***");
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] accept-pending ${redact(msg)}`);
}

/** Turso connection from the environment (GitHub Actions secrets, or local env). */
export function tursoClientFromEnv(env = process.env) {
  const url = env.TURSO_DATABASE_URL || env.TURSO_URL;
  const authToken = env.TURSO_AUTH_TOKEN || env.TURSO_TOKEN;
  if (!url || !authToken) {
    const err = new Error("NO-TURSO-CREDENTIALS: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (or TURSO_URL / TURSO_TOKEN)");
    err.exitCode = EXIT_NO_CREDENTIALS;
    throw err;
  }
  // libsql:// speaks the pipe protocol; the HTTPS endpoint is what both the
  // local shell and Actions can reach.
  return createClient({ url: String(url).replace(/^libsql:\/\//, "https://"), authToken });
}

/** The task row, as plain fields (rows come back as objects, but be defensive). */
export async function readTaskRow(taskId, client) {
  const res = await client.execute({
    sql: "SELECT id, text, status, result, metadata FROM tasks WHERE id = ?",
    args: [taskId],
  });
  const row = res && res.rows ? res.rows[0] : null;
  if (!row) return null;
  let metadata = {};
  try { metadata = row.metadata ? (typeof row.metadata === "object" ? row.metadata : JSON.parse(row.metadata)) : {}; }
  catch { metadata = {}; }
  if (!metadata || typeof metadata !== "object") metadata = {};
  return { id: Number(row.id), status: String(row.status || ""), result: String(row.result || ""), metadata };
}

/** Where the work is preserved: the row's own answer wins over the convention. */
export function pendingBranchFor(task, taskId) {
  const named = task && task.metadata && task.metadata.pending_branch;
  if (typeof named === "string" && /^pending\/task-[A-Za-z0-9_-]+$/.test(named)) return named;
  return `${DEFAULT_PENDING_PREFIX}${String(taskId).replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** The branch the task worked on - the brief names it, main is the fallback. */
export function targetBranchFor(task, fallbackBranch) {
  if (fallbackBranch) return fallbackBranch;
  const fromMeta = task && task.metadata && task.metadata.target_branch;
  if (typeof fromMeta === "string" && /^[A-Za-z0-9._\/-]+$/.test(fromMeta)) return fromMeta;
  return "main";
}

/**
 * Merge one preserved task into its target branch.
 *
 * Returns { ok, code, ... }. Steps in order, each one fail-closed:
 *   1. the row exists and says 'принята'   -> EXIT_NOT_ACCEPTED / EXIT_TASK_NOT_FOUND
 *   2. the target repo is a clean git tree -> EXIT_WORKDIR_DIRTY
 *   3. the pending ref exists on origin    -> 'PENDING-BRANCH-MISSING'
 *   4. merge --no-ff into the target       -> EXIT_CONFLICT (aborts the merge, no push)
 *   5. push + verify against origin       -> EXIT_PUSH_NOT_VERIFIED
 *   6. write 'готова' to the row
 *   7. delete the pending ref (warning only: the merge is already published)
 */
export async function mergePending({
  taskId,
  repoPath,
  targetBranch: targetBranchArg,
  pendingBranch: pendingBranchArg,
  loadTask = (id) => readTaskRow(id, tursoClientFromEnv()),
  saveVerdict = async (id) => {
    const client = tursoClientFromEnv();
    await client.execute({ sql: "UPDATE tasks SET status = ?, result = ? WHERE id = ?", args: [DONE_STATUS, "accepted by the founder and merged by scripts/accept-pending.mjs", id] });
  },
  exec = (cmd, opts) => execSync(cmd, { stdio: "pipe", ...opts }),
  headSha: headShaFn = (dir) => exec("git rev-parse HEAD", { cwd: dir }).toString().trim(),
  remoteSha: remoteShaFn = (branch, dir) => exec(`git ls-remote origin refs/heads/${JSON.stringify(branch)}`, { cwd: dir }).toString().trim().split(/\s+/)[0],
}) {
  // Every failure carries BOTH a name and an exit code: the name is for a human
  // reading the log, the number is for CI, and one must never be mistaken for
  // the other.
  const fail = (code, reason, extra) => ({
    ok: false,
    code,
    reason: redact(reason),
    exitCode: extra && extra.exitCode != null ? extra.exitCode : EXIT_FAILED,
    ...(extra || {}),
  });
  const run = (cmd) => exec(cmd, { cwd: repoPath }).toString().trim();
  const pendingBranch = pendingBranchArg || `${DEFAULT_PENDING_PREFIX}${String(taskId).replace(/[^A-Za-z0-9_-]/g, "")}`;

  // 1. the decision is the barrier. Anything that is not 'принята' stops here:
  //    this script must never become a way to publish unaccepted work.
  const task = await loadTask(taskId).catch((err) => { throw err; });
  if (!task) return fail("TASK-NOT-FOUND", `task ${taskId}: no such row in Turso`, { exitCode: EXIT_TASK_NOT_FOUND });
  // Already published: the executor's own wait loop saw the decision and pushed
  // (it does not go through pending/). Nothing to merge, and nothing to close
  // again - this is the outcome of the immediate trigger in the common case,
  // which is why it must not read as a failure. (S15, 2026-11-11)
  if (task.status === DONE_STATUS) {
    return { ok: true, code: "ALREADY-DONE", exitCode: EXIT_OK, taskId, reason: `task ${taskId} is already '${DONE_STATUS}' - nothing to merge`, alreadyDone: true };
  }
  if (task.status !== ACCEPTED_STATUS) {
    return fail("NOT-ACCEPTED", `task ${taskId} is '${task.status}', not '${ACCEPTED_STATUS}' - the founder's decision is the only thing this script acts on`, { exitCode: EXIT_NOT_ACCEPTED });
  }
  const targetBranch = targetBranchFor(task, targetBranchArg);

  // 2. refuse to move branches with uncommitted work lying around: the switch
  //    would either fail halfway or carry unrelated edits into the merge.
  if (!fs.existsSync(repoPath)) return fail("TARGET-REPO-MISSING", `target repo path does not exist: ${repoPath}`, { exitCode: EXIT_FAILED });
  const dirty = exec("git status --porcelain", { cwd: repoPath }).toString().trim();
  if (dirty) {
    return fail("WORKDIR-DIRTY", `the target repo has uncommitted work; nothing was touched:\n${dirty.split("\n").slice(0, 10).join("\n")}`, { exitCode: EXIT_WORKDIR_DIRTY });
  }

  // 3. bring the preserved work home. The local branch is created (force) so the
  //    founder's own documented command `git merge pending/task-<id>` also works
  //    by hand afterwards; the merge below uses FETCH_HEAD either way.
  try {
    run(`git fetch origin +refs/heads/${JSON.stringify(pendingBranch)}:refs/heads/${JSON.stringify(pendingBranch)}`);
  } catch (err) {
    // Two different failures that look alike on the surface, and must not be
    // reported as one thing:
    //   - the ref is simply not there yet: the executor is still publishing the
    //     commit itself (its poll is 30s, the immediate dispatch is seconds).
    //     The race is normal, so say NOT-READY and let the cron retry. Failing
    //     the workflow here would be noise on every fast acceptance (S15).
    //   - the REMOTE is unreachable/wrong: a real, actionable failure - a human
    //     has to fix credentials or URL, and no amount of retrying will help.
    const detail = (err.stderr ? err.stderr.toString() : err.message).split("\n")[0];
    const missingRef = /couldn't find remote ref|remote ref does not exist|no such ref was fetched/i.test(detail);
    if (missingRef && task.status === ACCEPTED_STATUS) {
      return fail("NOT-READY", `task ${taskId} is '${ACCEPTED_STATUS}' but ${pendingBranch} is not on origin yet (${detail}) - the executor is most likely publishing the commit itself; nothing was touched`, { exitCode: EXIT_NOT_READY, pendingBranch, targetBranch });
    }
    return fail("PENDING-BRANCH-MISSING", `pending branch ${pendingBranch} could not be fetched (${detail}) - nothing to merge`, { exitCode: EXIT_FAILED });
  }
  const fetchedSha = run("git rev-parse FETCH_HEAD");
  log(`fetched ${pendingBranch} as ${fetchedSha.slice(0, 8)}`);

  // 4. onto the target branch.
  try {
    run(`git checkout ${JSON.stringify(targetBranch)}`);
  } catch {
    try { run(`git checkout -B ${JSON.stringify(targetBranch)} origin/${JSON.stringify(targetBranch)}`); }
    catch (err) { return fail("TARGET-BRANCH-MISSING", `target branch ${targetBranch} could not be checked out: ${err.message}`, { exitCode: EXIT_FAILED }); }
  }
  const beforeMerge = headShaFn(repoPath);
  try {
    run(`git merge --no-ff FETCH_HEAD -m "task ${taskId}: принята после просроченного окна"`);
  } catch (err) {
    // A conflict is a founder decision, not a script decision: abort it, leave
    // the target branch exactly as it was, push nothing, close nothing.
    try { exec("git merge --abort", { cwd: repoPath, stdio: "pipe" }); } catch {}
    const detail = (err.stderr ? err.stderr.toString() : err.message).split("\n").slice(0, 8).join("\n");
    return fail("MERGE-CONFLICT", `MERGE-CONFLICT merging ${pendingBranch} into ${targetBranch}; the merge was aborted, nothing was pushed\n${detail}`, {
      exitCode: EXIT_CONFLICT,
      pendingBranch,
      targetBranch,
    });
  }
  const mergedSha = headShaFn(repoPath);
  log(`merged ${fetchedSha.slice(0, 8)} into ${targetBranch} as ${mergedSha.slice(0, 8)} (was ${beforeMerge.slice(0, 8)})`);

  // 5. publish, then verify the publish - an exit-0 push whose ref never moved
  //    is indistinguishable from a good one without this check.
  try {
    exec(`git push origin ${JSON.stringify(targetBranch)}`, { cwd: repoPath, stdio: "pipe" });
  } catch (err) {
    return fail("PUSH-NOT-VERIFIED", `push to origin/${targetBranch} failed: ${err.message.split("\n")[0]}`, { exitCode: EXIT_PUSH_NOT_VERIFIED, targetBranch });
  }
  let landed = null;
  try { landed = await remoteShaFn(targetBranch, repoPath); } catch { landed = null; }
  if (!landed || landed !== mergedSha) {
    return fail("PUSH-NOT-VERIFIED", `commit not on GitHub: origin refs/heads/${targetBranch} does not point at ${mergedSha.slice(0, 8)} (it points at ${landed ? landed.slice(0, 8) : "nothing"}) - the merge is local and the row is NOT closed`, {
      exitCode: EXIT_PUSH_NOT_VERIFIED, targetBranch, mergedSha,
    });
  }
  log(`verified: origin/${targetBranch} -> ${landed.slice(0, 8)}`);

  // 6. only now is the task 'готова': the work is published AND the verdict says so.
  //    If the write itself fails, the git state is ahead of the row - a state
  //    somebody has to reconcile, said with the sha rather than swallowed into
  //    an exit code that looks like "nothing happened".
  try {
    await saveVerdict(taskId, { mergedSha, pendingBranch, targetBranch });
  } catch (err) {
    return fail("VERDICT-UNWRITTEN", `merged and verified as ${mergedSha.slice(0, 8)} on origin/${targetBranch}, but the verdict was NOT written (${String(err.message).split("\n")[0]}) - the row is still '${ACCEPTED_STATUS}' and must be closed by hand`, {
      exitCode: EXIT_FAILED, code_: "VERDICT-UNWRITTEN", mergedSha, targetBranch,
    });
  }
  log(`task ${taskId} is now '${DONE_STATUS}'`);

  // 7. retire the preservation ref. If this fails the merge still stands and the
  //    row is closed; the leftover ref is a cleanup note, not a failure.
  let pendingDeleted = true;
  try {
    exec(`git push origin :refs/heads/${JSON.stringify(pendingBranch)}`, { cwd: repoPath, stdio: "pipe" });
    exec(`git branch -D ${JSON.stringify(pendingBranch)}`, { cwd: repoPath, stdio: "pipe" });
    log(`deleted ${pendingBranch} from origin and locally`);
  } catch (err) {
    pendingDeleted = false;
    log(`WARNING: the merge is published but the pending ref could not be deleted (${err.message.split("\n")[0]}) - delete it by hand: git push origin :refs/heads/${pendingBranch}`);
  }

  return { ok: true, code: "OK", exitCode: EXIT_OK, taskId, targetBranch, pendingBranch, mergedSha, landed, pendingDeleted };
}

const usage = () => {
  console.error("usage: node scripts/accept-pending.mjs <taskId> <targetRepoPath> <targetBranch> [pendingBranch]");
  console.error("  e.g. node scripts/accept-pending.mjs 181 ./plexus-doc main");
};

async function main(argv) {
  const [taskIdArg, repoPathArg, targetBranchArg, pendingBranchArg] = argv;
  if (!taskIdArg || !repoPathArg || !targetBranchArg) { usage(); return EXIT_FAILED; }
  const taskId = Number(taskIdArg);
  if (!Number.isInteger(taskId) || taskId <= 0) { console.error(`invalid taskId: ${taskIdArg}`); return EXIT_FAILED; }

  let result;
  try {
    result = await mergePending({ taskId, repoPath: repoPathArg, targetBranch: targetBranchArg, pendingBranch: pendingBranchArg });
  } catch (err) {
    if (err.exitCode != null) { log(err.message); return err.exitCode; }
    log(`FAILED: ${err.stack || err.message}`);
    return EXIT_FAILED;
  }
  if (result.ok) {
    log(`OK task ${taskId}: ${result.mergedSha.slice(0, 8)} merged into ${result.targetBranch} and verified on origin; pending ref ${result.pendingBranch} ${result.pendingDeleted ? "deleted" : "STILL PRESENT (see warning above)"}`);
    return EXIT_OK;
  }
  log(`FAILED [${result.code || result.exitCode}]: ${result.reason}`);
  return result.exitCode != null ? result.exitCode : EXIT_FAILED;
}

// Only run as a program, never on import - tests import the functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
