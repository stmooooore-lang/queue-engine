// ACCEPT-PENDING: the founder's decision is the barrier, the push is verified.
//
// Real git against a real bare origin (the same harness shape as
// tests/commit-verification.mjs): every git step below is a real command, and
// only the Turso row is injected - because a test that fakes git would prove
// nothing about a merge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { mergePending, pendingBranchFor, targetBranchFor, redact } from "../scripts/accept-pending.mjs";

const passed = [];
const failed = [];
const started = new Date().toISOString();
function check(name, ok, detail) {
  if (ok) { passed.push(name); console.log(`  PASS  ${name}`); }
  else { failed.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? `\n        ${String(detail).split("\n").slice(0, 12).join("\n        ")}` : ""}`); }
}
function sh(cmd, cwd) { return execSync(cmd, { cwd, stdio: "pipe" }).toString().trim(); }
const say = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function makeRepo(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `accept-pending-${name}-`));
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir);
  const gitDir = path.join(base, "repo.git");
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "CI Bot", GIT_AUTHOR_EMAIL: "ci@example.com",
    GIT_COMMITTER_NAME: "CI Bot", GIT_COMMITTER_EMAIL: "ci@example.com",
  };
  execSync("git init -q", { cwd: dir, stdio: "pipe", env: commitEnv });
  sh("git symbolic-ref HEAD refs/heads/main", dir);
  fs.writeFileSync(path.join(dir, "seed.md"), "seed\n");
  sh("git add -A", dir); sh("git commit -q -m seed", dir);
  sh(`git init -q --bare ${JSON.stringify(gitDir)}`, base);
  sh(`git remote add origin ${JSON.stringify(gitDir)}`, dir);
  sh("git push -q origin main", dir);
  return dir;
}

function fakeRow(status, metadata = {}) {
  return { id: 181, status, result: "", metadata };
}

// Simulate the executor's timeout: the work is preserved in pending/task-181 and
// the row is parked as 'ждёт_приёмки_просрочено'.
function preserveWork(dir, files = ["artifact.md"], taskId = 181) {
  const pre = sh("git rev-parse HEAD", dir);
  for (const f of files) fs.writeFileSync(path.join(dir, f), `${f} by the task\n`);
  sh("git add -A", dir);
  sh(`git commit -q -m "task ${taskId}: accepted-after-overdue work"`, dir);
  const sha = sh("git rev-parse HEAD", dir);
  sh(`git push -q origin HEAD:refs/heads/pending/task-${taskId}`, dir);
  return { pre, sha };
}

// What merge-pending.yml actually runs against: a FRESH checkout of the target
// repo. In the executor's own repo the work sits on local main (unpushed), so a
// same-clone merge is trivially "already up to date"; the workflow never is, and
// the merge node it produces is what the founder reads later. Both shapes are
// exercised below - the fresh one first, because that is the universal path.
function simulateFreshCheckout(dir) {
  sh("git checkout -q main", dir);
  sh("git reset -q --hard origin/main", dir);
}

say("=== ACCEPT-PENDING: universal acceptance merge ===");
// T0: the same-clone caller (the executor's own tree, where the work was never
// pushed). "Already up to date" must still publish the work - a merge node is a
// nicety, publishing is the guarantee.
{
  const dir = makeRepo("sameclone");
  const work = preserveWork(dir);
  const result = await mergePending({
    taskId: 181, repoPath: dir,
    loadTask: async () => fakeRow("принята"), saveVerdict: async () => {},
  });
  check("T0 a caller that already has the work locally also gets it published",
    result.ok === true && sh("git rev-parse origin/main", dir) === work.sha,
    `${JSON.stringify(result)} origin/main=${sh("git rev-parse origin/main", dir)} work=${work.sha}`);
  check("T0b ...and the pending ref is retired afterwards",
    sh("git ls-remote --heads origin", dir).split("\n").filter((l) => l.includes("pending")).length === 0, sh("git ls-remote --heads origin", dir));
}



// T1: the happy path - decision, fetch, merge, push, verify, close, cleanup.
{
  const dir = makeRepo("happy");
  const work = preserveWork(dir);
  simulateFreshCheckout(dir);   // the workflow's shape: local main without the work
  // The row was parked as 'ждёт_приёмки_просрочено', and the founder's decision
  // moved it to 'принята' - that change is the only thing this script reacts to.
  let row = fakeRow("принята", { pending_branch: "pending/task-181", target_branch: "main" });
  const verdicts = [];
  const result = await mergePending({
    taskId: 181,
    repoPath: dir,
    loadTask: async () => row,
    saveVerdict: async (id, meta) => { verdicts.push({ id, meta }); },
  });
  check("T1 the accepted task merges and closes",
    result.ok === true && result.targetBranch === "main" && verdicts.length === 1 && verdicts[0].id === 181,
    JSON.stringify(result) + " verdicts=" + JSON.stringify(verdicts));
  check("T2 ...the merge is a REAL merge node (not a fast-forward)",
    result.mergedSha !== work.sha && sh("git rev-parse HEAD", dir) === result.mergedSha,
    `HEAD=${sh("git rev-parse HEAD", dir)} preserved=${work.sha} merged=${result.mergedSha}`);
  check("T3 ...and the target branch on origin holds it",
    sh("git rev-parse origin/main", dir) === result.mergedSha, `origin/main=${sh("git rev-parse origin/main", dir)}`);
  check("T4 ...the work is really in the file",
    fs.readFileSync(path.join(dir, "artifact.md"), "utf8").includes("by the task"), "");
  check("T5 ...the pending ref was deleted from origin",
    sh("git ls-remote --heads origin", dir).split("\n").filter((l) => l.includes("pending")).length === 0, sh("git ls-remote --heads origin", dir));
  check("T6 ...the pass-start sha is an ancestor, so nothing was dropped",
    sh(`git merge-base --is-ancestor ${work.pre} HEAD`, dir) === "", "");
}

// T7: a conflict is a decision, not something to resolve: abort, push nothing.
{
  const dir = makeRepo("conflict");
  const conflicting = preserveWork(dir, ["artifact.md"]);
  simulateFreshCheckout(dir);
  // Someone else moved main forward on top of the same file.
  fs.writeFileSync(path.join(dir, "artifact.md"), "competing work by someone else\n");
  sh("git add -A", dir); sh('git commit -q -m "competing change"', dir);
  const localBefore = sh("git rev-parse HEAD", dir);
  const beforePush = sh("git rev-parse origin/main", dir);
  const result = await mergePending({
    taskId: 181,
    repoPath: dir,
    loadTask: async () => fakeRow("принята", { pending_branch: "pending/task-181", target_branch: "main" }),
    saveVerdict: async () => { throw new Error("the row must not be closed on a conflict"); },
  });
  check("T7 a merge conflict fails with MERGE-CONFLICT",
    result.ok === false && result.code === "MERGE-CONFLICT", JSON.stringify(result));
  check("T8 ...the row is NOT closed and the reason says so",
    /row is NOT closed|MERGE-CONFLICT/.test(result.reason), result.reason);
  check("T9 ...nothing was pushed to the target branch",
    sh("git rev-parse origin/main", dir) === beforePush, `origin/main=${sh("git rev-parse origin/main", dir)} before=${beforePush}`);
  check("T10 ...the merge was aborted, so the tree is clean and main is untouched",
    sh("git status --porcelain", dir) === "" && sh("git symbolic-ref --short HEAD", dir) === "main" && sh("git rev-parse HEAD", dir) === localBefore,
    `status=[${sh("git status --porcelain", dir)}] branch=${sh("git symbolic-ref --short HEAD", dir)} HEAD=${sh("git rev-parse HEAD", dir)} localBefore=${localBefore}`);
  check("T11 ...and the preserved work is still on origin, not lost",
    sh("git rev-parse origin/pending/task-181", dir) === conflicting.sha, sh("git ls-remote --heads origin", dir));
}

// T12: the barrier itself - no 'принята', no merge, no push.
for (const status of ["ждёт_приёмки", "ждёт_приёмки_просрочено", "выполняется", "провал"]) {
  const dir = makeRepo("barrier");
  preserveWork(dir);
  const before = sh("git rev-parse origin/main", dir);
  const localBefore = sh("git rev-parse HEAD", dir);
  const result = await mergePending({
    taskId: 181,
    repoPath: dir,
    loadTask: async () => fakeRow(status),
    saveVerdict: async () => { throw new Error("must not close a row that was not accepted"); },
  });
  check(`T12 [${status}] is not a decision, so nothing happens`,
    result.ok === false && result.exitCode === 2 && new RegExp(status).test(result.reason),
    `${result.code} ${result.reason}`);
  check(`T13 [${status}] neither the target branch nor the tree was touched`,
    sh("git rev-parse origin/main", dir) === before && sh("git rev-parse HEAD", dir) === localBefore,
    `origin/main=${sh("git rev-parse origin/main", dir)}==${before} HEAD=${sh("git rev-parse HEAD", dir)}==${localBefore}`);
}

// T14: a missing row is not a silent success.
{
  const dir = makeRepo("norow");
  preserveWork(dir);
  const result = await mergePending({
    taskId: 181, repoPath: dir,
    loadTask: async () => null, saveVerdict: async () => {},
  });
  check("T14 a task that does not exist fails with TASK-NOT-FOUND",
    result.ok === false && result.exitCode === 6 && result.code === "TASK-NOT-FOUND", JSON.stringify(result));
}

// T15: uncommitted work in the target repo stops the script before it switches
// branches - otherwise it would carry a stranger's edits into the merge.
{
  const dir = makeRepo("dirty");
  preserveWork(dir);
  fs.writeFileSync(path.join(dir, "scratch.txt"), "not mine, not committed\n");
  const result = await mergePending({
    taskId: 181, repoPath: dir,
    loadTask: async () => fakeRow("принята"), saveVerdict: async () => { throw new Error("must not close"); },
  });
  check("T15 a dirty target repo fails with WORKDIR-DIRTY before any git move",
    result.ok === false && result.exitCode === 3 && /scratch\.txt/.test(result.reason), `${result.code} ${result.reason}`);
  check("T16 ...and the branch was never switched",
    sh("git symbolic-ref --short HEAD", dir) === "main", sh("git symbolic-ref --short HEAD", dir));
}

// T17: the preservation ref is gone -> nothing to merge, and a push that exits 0
// but does not move the ref is caught like any other lie.
{
  const dir = makeRepo("badremote");
  preserveWork(dir);
  simulateFreshCheckout(dir);
  sh("git remote set-url origin /definitely/not/a/git/repository", dir);
  const result = await mergePending({
    taskId: 181, repoPath: dir,
    loadTask: async () => fakeRow("принята"), saveVerdict: async () => { throw new Error("must not close"); },
  });
  check("T17 an unreachable remote is a real failure, not 'not ready'",
    result.ok === false && result.code === "PENDING-BRANCH-MISSING" && result.exitCode === 1 && result.code_1 !== "NOT-READY",
    JSON.stringify(result));
}
{
  const dir = makeRepo("liarpush");
  preserveWork(dir);
  simulateFreshCheckout(dir);
  let saveCalled = 0;
  const result = await mergePending({
    taskId: 181, repoPath: dir,
    loadTask: async () => fakeRow("принята"),
    saveVerdict: async () => { saveCalled += 1; },
    remoteSha: async () => "0".repeat(40),   // the push "succeeded", origin did not move
  });
  check("T18 an exit-0 push whose ref never moved closes NOTHING",
    result.ok === false && result.exitCode === 5 && saveCalled === 0, `${result.code} ${result.reason}`);
}

// T19: the naming helpers - invalid metadata falls back to the convention.
check("T19 the pending ref comes from the row when the row names it",
  pendingBranchFor({ metadata: { pending_branch: "pending/task-999" } }, 181) === "pending/task-999", pendingBranchFor({ metadata: { pending_branch: "pending/task-999" } }, 181));
check("T20 ...and an unsafe name is ignored, not passed to git",
  pendingBranchFor({ metadata: { pending_branch: "pending/task-9;rm -rf" } }, 181) === "pending/task-181", pendingBranchFor({ metadata: { pending_branch: "pending/task-9;rm -rf" } }, 181));
check("T21 the target branch prefers the row, then the argument, then main",
  targetBranchFor({ metadata: { target_branch: "cursor-build" } }, undefined) === "cursor-build"
  && targetBranchFor({ metadata: {} }, "release") === "release"
  && targetBranchFor({ metadata: {} }, undefined) === "main", "");
check("T22 credentials are masked in anything that reaches a log",
  /MASKED/.test(redact("Authorization: Bearer gsk_abcdef1234567890 token=deadbeefcafebabe")) && redact("Authorization: Bearer gsk_abcdef1234567890 token=deadbeefcafebabe").indexOf("deadbeef") === -1,
  redact("Authorization: Bearer gsk_abcdef1234567890 token=deadbeefcafebabe"));

// T23: the merge node is readable in the log history - that is the whole point
// of --no-ff on an overdue acceptance.
{
  const dir = makeRepo("history");
  const work = preserveWork(dir);
  simulateFreshCheckout(dir);   // a fresh caller is the universal path
  await mergePending({
    taskId: 181, repoPath: dir,
    loadTask: async () => fakeRow("принята"), saveVerdict: async () => {},
  });
  const history = sh('git log --oneline -3 --format=%s', dir);
  check("T23 the merge commit says who accepted it and why",
    /принята после просроченного окна/.test(history), history);
  check("T24 the preserved commit itself is in history too (re-findable)",
    sh("git log --oneline", dir).includes(work.sha.slice(0, 8)) || sh("git rev-list --all", dir).includes(work.sha), "");

  // For a later `git clean`-style teardown: the work dir is temporary and the
  // bare origin is separate, so leftovers never touch the real repositories.
}

// T25 group: a task/<N> TEST branch is verified and deleted, never merged.
// queue-engine/AGENTS.md "Branching Rules" (2026-11-11): test tasks live on
// task/<N>, they are NOT merged into target branches, and they are removed
// after verification. The merge script therefore must not treat a test target
// as an ordinary one: no merge, no merge commit, no push of a branch that only
// existed to be looked at.
{
  const dir = makeRepo("testbranch");
  const work = preserveWork(dir, ["artifact.md"], 184);
  simulateFreshCheckout(dir);
  // A test task can also carry its own branch on origin (the executor creates
  // it when the work is accepted in-window); its tip IS the verified work.
  sh("git push -q origin HEAD:refs/heads/task/184", dir);
  const verdict = {};
  const result = await mergePending({
    taskId: 184, repoPath: dir,
    loadTask: async () => fakeRow("принята", { pending_branch: "pending/task-184", target_branch: "task/184" }),
    saveVerdict: async (id, info) => { Object.assign(verdict, { id, info }); },
  });
  check("R1 a test branch is closed with its own code, not a merge",
    result.ok === true && result.code === "TEST-BRANCH-VERIFIED" && result.testBranch === true, JSON.stringify(result));
  check("R2 ...and NO merge happened in the target repo",
    sh("git rev-parse HEAD", dir) === sh("git rev-parse origin/main", dir), `HEAD=${sh("git rev-parse HEAD", dir)} origin/main=${sh("git rev-parse origin/main", dir)}`);
  check("R3 ...and main still does not hold the test work",
    sh("git rev-parse origin/main", dir) === work.pre, `origin/main=${sh("git rev-parse origin/main", dir)} pre=${work.pre}`);
  check("R4 ...and the preservation ref is deleted after being verified",
    result.pendingDeleted === true && sh("git ls-remote origin refs/heads/pending/task-184", dir) === "", `ls-remote=${sh("git ls-remote origin refs/heads/pending/task-184", dir)}`);
  check("R5 ...and the test branch itself is removed from origin",
    result.testBranchDeleted === true && sh("git ls-remote origin refs/heads/task/184", dir) === "", `ls-remote=${sh("git ls-remote origin refs/heads/task/184", dir)}`);
  check("R6 ...and the verdict names exactly what was verified",
    verdict.id === 184 && verdict.info.testBranch === true && verdict.info.preservedSha === work.sha, JSON.stringify(verdict));
}
{
  // A test branch whose remote tip is NOT this task's work is left alone:
  // deleting it would delete somebody else's branch.
  const dir = makeRepo("testbranchforeign");
  const work = preserveWork(dir, ["artifact.md"], 184);
  simulateFreshCheckout(dir);
  // A commit that is NOT in the preserved work's ancestry: created off the
  // pass-start sha, so the remote test branch's tip holds content this task
  // never had. Ancestry, not equality, is the test - a branch tip equal to
  // the verified commit is this task's own work and IS removed.
  sh(`git checkout -q ${work.pre.slice(0, 8)}`, dir);
  sh("git checkout -q -b other", dir);
  fs.writeFileSync(path.join(dir, "somebody-elses-work.md"), "not this task\n");
  sh("git add -A", dir); sh('git commit -q -m "foreign work"', dir);
  sh("git push -q origin other:refs/heads/task/184", dir);
  sh("git checkout -q main", dir);
  const result = await mergePending({
    taskId: 184, repoPath: dir,
    loadTask: async () => fakeRow("принята", { pending_branch: "pending/task-184", target_branch: "task/184" }),
    saveVerdict: async () => {},
  });
  check("R7 a test branch holding foreign work is NOT deleted",
    result.ok === true && result.testBranchDeleted === false, JSON.stringify(result));
  check("R8 ...and it is still on origin",
    sh("git ls-remote origin refs/heads/task/184", dir) !== "", "the foreign branch disappeared");
  check("R9 ...while this task's own preservation ref is still retired",
    result.pendingDeleted === true && sh("git ls-remote origin refs/heads/pending/task-184", dir) === "", JSON.stringify(result));
}
{
  // Verification first: an unverifiable preservation is closed by nobody.
  const dir = makeRepo("testbranchunverified");
  const work = preserveWork(dir, ["artifact.md"], 184);
  simulateFreshCheckout(dir);
  // The ref is fetchable but no longer points where the fetch said it did:
  // the one shape where "verified against the remote ref" is the whole test.
  // remoteSha is a parameter precisely so this can be forced without a race.
  const result = await mergePending({
    taskId: 184, repoPath: dir,
    loadTask: async () => fakeRow("принята", { pending_branch: "pending/task-184", target_branch: "task/184" }),
    saveVerdict: async () => { throw new Error("must not close a row whose work cannot be verified"); },
    remoteSha: async () => "0".repeat(40),
  });
  check("R10 a test branch whose work cannot be verified is NOT closed",
    result.ok === false && /TEST-BRANCH-UNVERIFIED/.test(JSON.stringify(result)), JSON.stringify(result));
}

// S: selection must not hand a merge a target it cannot honour.
// A preserved violation with a detached head has target_branch = "" (there is
// nothing to merge into), and defaulting that to "main" would publish the
// violation into the branch it was about - so the selection skips it.
{
  const lister = await import("../scripts/list-accepted-pending.mjs");
  const fakeClient = (rows) => ({ execute: async () => ({ rows }) });
  const row = (id, meta) => ({ id, metadata: JSON.stringify(meta) });
  check("S1 a preserved task with a named target is selected",
    JSON.stringify(await lister.selectAcceptedPending(fakeClient([
      row(181, { pending_branch: "pending/task-181", target_branch: "main" }),
    ]))) === JSON.stringify([{ id: 181, targetBranch: "main", pendingBranch: "pending/task-181" }]),
    JSON.stringify(await lister.selectAcceptedPending(fakeClient([row(181, { pending_branch: "pending/task-181", target_branch: "main" })]))));
  check("S2 ...and one whose target was never recorded is NOT selected",
    (await lister.selectAcceptedPending(fakeClient([
      row(184, { pending_branch: "pending/task-184", target_branch: "" }),
    ]))).length === 0,
    JSON.stringify(await lister.selectAcceptedPending(fakeClient([row(184, { pending_branch: "pending/task-184", target_branch: "" })]))));
  check("S3 ...and a target with no pending ref is not selected either",
    (await lister.selectAcceptedPending(fakeClient([row(183, { target_branch: "main" })]))).length === 0, "");
  check("S4 a task/<N> target IS selected (it is retired, not merged, by R above)",
    JSON.stringify(await lister.selectAcceptedPending(fakeClient([
      row(185, { pending_branch: "pending/task-185", target_branch: "task/185" }),
    ]))) === JSON.stringify([{ id: 185, targetBranch: "task/185", pendingBranch: "pending/task-185" }]),
    "");
}

say(`=== ${passed.length} passed, ${failed.length} failed ===`);
for (const f of failed) console.log(`  FAIL  ${f.name}\n        ${String(f.detail).split("\n").slice(0, 14).join("\n        ")}`);
process.exit(failed.length ? 1 : 0);
