/**
 * EXECUTOR-COMMIT-VERIFICATION, 2026-11-09 - the artifact guard.
 *
 * The founder's brief, exactly:
 *   "Создай тестовую задачу через воркер... задача должна упасть с ошибкой
 *    `commit not on GitHub`, а не получить `готова`" - i.e. prove that a task
 *    whose artifacts never landed cannot be 'готова' any more.
 *
 * What is asserted here, in the order the holes were found:
 *   A. FIX 1 - an empty working tree is NOT 'ready'. pushTaskArtifacts()
 *      returns false unless the brief declared [NO-ARTIFACT].
 *   B. FIX 1 escape hatch - [NO-ARTIFACT] is the one lawful empty tree, so the
 *      guard does not punish tasks that legitimately produce no file change.
 *   C. FIX 2 - after a real push, the commit is verified against origin
 *      (commitReachedOrigin returns the SHA); a HEAD that the remote does not
 *      hold is refused, which is the "commit not on GitHub" verdict itself.
 *   D. FIX 3 - a branch the brief named and could not check out THROWS
 *      instead of silently committing to the default checkout.
 *   E. The founder's headline: empty tree -> the task's status is 'провал',
 *      never 'готова'. That is a decision made in taskVerdictFromResult(), so
 *      it is executed here rather than eyeballed.
 *   F. No regression: a real, pushed commit still ends up 'готова'.
 *   Manifest staging, 2026-11-10 (PUSH-AFTER-ACCEPTANCE): `git add -A` is gone
 *   from both staging paths, so every case that writes a file now names it in a
 *   "MANIFEST:" line (or in the agent report passed as resultText). The gate
 *   itself - stage, wait for 'принята', then push - is asserted separately in
 *   tests/acceptance-gate.mjs.
 *
 * Everything runs against REAL git repositories created in a temp directory -
 * no mock of git, because the fake-done report was produced by a real git
 * status being real and empty.
 *
 * Local-Cloud Parity: the local contour (queue.sh) has no push step at all -
 * its repo has no remote by rule - so it has no SHA-against-origin analogue.
 * Its equivalent hole (a brief requiring a file that the agent never wrote)
 * is guarded by queue-checklist-ai/QA, i.e. differently, and that divergence
 * is recorded in docs/DECISIONS.md 2026-11-09 rather than closed silently
 * here.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${String(detail).slice(0, 400)}`); }
}
function sh(cmd, cwd) { return execFileSync("bash", ["-lc", cmd], { cwd, stdio: "pipe" }).toString().trim(); }
const quiet = { stdio: "pipe" };

// A fresh WORKDIR for each case. WORKDIR is read once, at module load, from
// process.env.WORKDIR - so the env is set BEFORE the import and each case gets
// its own module instance via a query-busted URL (Node treats ?case=N as a
// distinct module: verified, the imported functions are not identical objects).
import { fileURLToPath, pathToFileURL } from "node:url";
// fileURLToPath, NOT `new URL(...).pathname` + dirname: the latter double-encodes
// the space in this project's path and then strips a real segment.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const executorPath = pathToFileURL(path.join(repoRoot, "scripts/executor.mjs")).href;
let caseNo = 0;
async function loadExecutor(workdir) {
  process.env.WORKDIR = workdir;
  return import(`${executorPath}?case=${++caseNo}`);
}

function makeRepo(name, { withRemote = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cverify-${name}-`));
  sh("git init -q . && git config user.email t@t && git config user.name t "
     + "&& git checkout -q -b main 2>/dev/null || true", dir);
  if (withRemote) {
    const bare = `${dir}.git`;
    sh(`git init -q --bare "${bare}"`, dir);
    sh(`git remote add origin "${bare}"`, dir);
  }
  return dir;
}

console.log("=== EXECUTOR-COMMIT-VERIFICATION: artifact guard ===\n");

// --- A: FIX 1, the hole Plexus measured -------------------------------
{
  const dir = makeRepo("empty");
  const ex = await loadExecutor(dir);
  const pushed = await ex.pushTaskArtifacts("[S14-13 S11-M] decide whether to build useDen...");
  check("A1 empty git status with a brief that claims artifacts -> pushTaskArtifacts() === false",
    pushed === false, `returned ${JSON.stringify(pushed)}`);
  check("A2 the refusal names the real cause, not a generic 'push failed'",
    /no artifacts|NO-ARTIFACT/.test(ex.getLastArtifactPushReason() || ""), ex.getLastArtifactPushReason());
  check("A3 and the verdict it produces is NOT 'готова'",
    ex.taskVerdictFromResult({ success: false, message: "x" },
      { verdict: { fatal: false, retryable: true }, isPermanentBlock: false, retryBudgetExhausted: false }) !== "готова",
    ex.taskVerdictFromResult({ success: false }, { verdict: {}, isPermanentBlock: false, retryBudgetExhausted: false }));
}

// --- B: the one lawful empty tree -------------------------------------
{
  const dir = makeRepo("noartifact");
  const ex = await loadExecutor(dir);
  const pushed = await ex.pushTaskArtifacts("[NO-ARTIFACT] audit only, no file change expected");
  check("B1 an explicit [NO-ARTIFACT] brief is still allowed to be 'ready' with an empty tree",
    pushed === true, `returned ${JSON.stringify(pushed)}; reason=${ex.getLastArtifactPushReason()}`);
  check("B2 its verdict is 'готова' - the escape hatch is not a dead end",
    ex.taskVerdictFromResult({ success: true }, {}) === "готова", "");
}

// --- C: FIX 2, a commit the remote does not hold -----------------------
{
  const dir = makeRepo("pushed", { withRemote: true });
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  sh("git add -A && git commit -q -m 'task 999: real work'", dir);
  // The push is what puts the SHA on origin - without it this scenario tests
  // an unpushed repo, not the verification.
  sh("git push -q -u origin main", dir);
  const ex = await loadExecutor(dir);
  const landed = ex.commitReachedOrigin("main", dir);
  check("C1 a commit that origin really holds is verified (SHA returned)",
    /^[0-9a-f]{40}$/.test(String(landed)), landed);
  check("C2 it equals the local HEAD exactly",
    landed === sh("git rev-parse HEAD", dir), `${landed} != ${sh("git rev-parse HEAD", dir)}`);
}
{
  // The exact "commit not on GitHub" shape: the push EXITS 0 (so nothing in
  // the old code could ever tell) while the ref is rewound behind our back.
  // Real, not mocked: a post-receive hook in the bare origin replays the
  // pre-push SHA over the ref after the update - the observable posture of a
  // proxy or edge that accepts a write and drops it.
  const dir = makeRepo("dropped", { withRemote: true });
  sh("git init -q --bare", dir);
  fs.writeFileSync(path.join(dir, "README.md"), "root\n");
  sh("git add -A && git commit -q -m seed && git push -q -u origin main", dir);
  const beforeSha = sh("git rev-parse origin/main", dir);
  fs.writeFileSync(path.join(dir, "dropped.txt"), "sha before push\n");
  fs.writeFileSync(path.join(dir, ".git-remote-hook.log"), "");
  const bare = `${dir}.git`;
  fs.writeFileSync(path.join(bare, "hooks", "post-receive"),
    `#!/bin/sh\ncat >> "${dir}/.git-remote-hook.log" <<EOF\nhook ran\nEOF\ngit update-ref refs/heads/main ${beforeSha}\n`,
    { mode: 0o755 });
  const ex = await loadExecutor(dir);
  const pushed = await ex.pushTaskArtifacts("[S14-20] triage notes into canon\nMANIFEST: dropped.txt");
  const reason = ex.getLastArtifactPushReason();
  check("C4 push exits 0 but the commit is NOT on GitHub -> pushTaskArtifacts() === false",
    pushed === false, `returned ${JSON.stringify(pushed)}; reason=${reason}`);
  check("C5 ...and the reason is the guard's own: 'commit not on GitHub'",
    /commit not on GitHub/.test(reason), reason);
  check("C6 ...so the task's verdict is 'провал', never 'готова'",
    ex.taskVerdictFromResult({ success: false, message: reason },
      { verdict: { fatal: false, retryable: true }, isPermanentBlock: false, retryBudgetExhausted: false }) === "провал",
    "");
}

{
  // A push that lands for real: changed files, remote present, nothing rewound
  // - the guard must not turn a healthy push into a failure.
  const dir = makeRepo("accepted", { withRemote: true });
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  sh("git add -A && git commit -q -m seed && git push -q -u origin main", dir);
  const ex = await loadExecutor(dir);
  fs.writeFileSync(path.join(dir, "b.md"), "two\n");
  const pushed = await ex.pushTaskArtifacts("[S14-20] triage notes into canon\nMANIFEST: b.md");
  check("C7 a real push with a changed tree is still accepted (true)",
    pushed === true, `${JSON.stringify(pushed)}: ${ex.getLastArtifactPushReason()}`);
  check("C8 and the commit is verifiably on origin afterwards",
    /^[0-9a-f]{40}$/.test(String(ex.commitReachedOrigin("main", dir))), ex.commitReachedOrigin("main", dir));
}

// --- D: FIX 3, the silent checkout ------------------------------------
{
  const dir = makeRepo("branch", { withRemote: true });
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  sh("git add -A && git commit -q -m seed && git push -q -u origin main", dir);
  const ex = await loadExecutor(dir);
  let threw = null;
  try { ex.checkoutTaskBranch("[BRANCH: no-such-branch] do the work"); } catch (e) { threw = e; }
  check("D1 a named branch that cannot be checked out THROWS instead of returning null",
    threw !== null && /BRANCH-NOT-ON-ORIGIN/.test(String(threw.message)), threw ? threw.message : "returned null silently");
  check("D2 the message says the task is not allowed to become 'готова' on the default checkout",
    /готова|default checkout/.test(String(threw && threw.message)), threw && threw.message);

  fs.writeFileSync(path.join(dir, "b.md"), "two\n");
  sh("git add -A && git commit -q -m second && git push -q origin HEAD:refs/heads/feature-x", dir);
  const got = ex.checkoutTaskBranch("[BRANCH: feature-x] do the work");
  check("D3 an existing named branch still checks out (no regression)",
    got === "feature-x", `got ${got}`);
}

// --- E: the founder's headline acceptance ------------------------------
{
  const dir = makeRepo("headline");
  const ex = await loadExecutor(dir);
  const pushedFalse = (await ex.pushTaskArtifacts("[S14-13] decide whether to build useDen")) === false;
  // doWork's contract: `if (!pushed) { result.success = false; }` - reproduced
  // here as the object the next step actually receives.
  const result = { success: !pushedFalse, message: pushedFalse ? "ARTIFACT-GUARD: " + ex.getLastArtifactPushReason() : "" };
  const status = ex.taskVerdictFromResult(result, {
    verdict: { fatal: false, retryable: true }, isPermanentBlock: false, retryBudgetExhausted: false,
  });
  check("E1 empty artifact tree -> the task's status is 'провал', NOT 'готова'",
    status === "провал", `status=${status}`);
  check("E2 the recorded result names the guard and the cause",
    /ARTIFACT-GUARD/.test(result.message) && /no artifacts/.test(result.message), result.message);
}

// --- F: no regression on the happy path -------------------------------
{
  const dir = makeRepo("happy", { withRemote: true });
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  sh("git add -A && git commit -q -m seed && git push -q -u origin main", dir);
  const ex = await loadExecutor(dir);
  fs.writeFileSync(path.join(dir, "c.md"), "three\n");
  const pushed = await ex.pushTaskArtifacts("[S14-20] real work\nMANIFEST: c.md");
  const status = ex.taskVerdictFromResult({ success: pushed === true, message: "" }, {
    verdict: { fatal: false, retryable: true }, isPermanentBlock: false, retryBudgetExhausted: false,
  });
  check("F1 a task that really pushes its artifacts still ends up 'готова'",
    status === "готова", `status=${status} pushed=${pushed} reason=${ex.getLastArtifactPushReason()}`);
}


// --- G: a MARKER is a declaration, not a mention (live finding, task 178) ---
// The first version of the regex matched the marker anywhere in the brief, so a
// brief that QUOTED the rule - "do NOT declare [NO-ARTIFACT]" - armed the
// escape hatch by accident. Task 178 received 'готова' that way on 2026-11-10.
{
  const dir = makeRepo("mention");
  const ex = await loadExecutor(dir);
  const quoted = "[E2E-TEST] create notes/x.md. Do NOT declare [NO-ARTIFACT] in any form.";
  const pushed = await ex.pushTaskArtifacts(quoted);
  check("G1 a brief that merely MENTIONS [NO-ARTIFACT] does not get the escape hatch",
    pushed === false, `returned ${JSON.stringify(pushed)}; reason=${ex.getLastArtifactPushReason()}`);
  check("G2 ...and its verdict is not 'готова'",
    ex.taskVerdictFromResult({ success: false, message: "x" },
      { verdict: { fatal: false, retryable: true }, isPermanentBlock: false, retryBudgetExhausted: false }) !== "готова", "");
}
{
  // The marker block at the top of a brief may hold several markers; a
  // declaration is still a declaration then. Regression guard for the anchoring.
  const dir = makeRepo("markerblock");
  const ex = await loadExecutor(dir);
  const pushed = await ex.pushTaskArtifacts("[NO-TRIAGE] [BRANCH: main] [NO-ARTIFACT] audit only");
  check("G3 a real declaration in the marker block still unlocks the empty tree",
    pushed === true, `returned ${JSON.stringify(pushed)}; reason=${ex.getLastArtifactPushReason()}`);
}
{
  // And the marker mid-brief (not in the block) is a mention, not a
  // declaration: the escape hatch must not open for it.
  const dir = makeRepo("midbrief");
  const ex = await loadExecutor(dir);
  const pushed = await ex.pushTaskArtifacts("Migrate the notes. If nothing changes, say [NO-ARTIFACT] here.");
  check("G4 the marker buried in prose is NOT treated as a declaration",
    pushed === false, `returned ${JSON.stringify(pushed)}; reason=${ex.getLastArtifactPushReason()}`);
}

// --- H: a clean tree can HIDE the agent's own commit (live, task 178) -----
// 2026-11-10, PUSH-AFTER-ACCEPTANCE blocker 2: the agent's commit must ALSO be
// declared in the brief's MANIFEST:/FILES: list, otherwise it is an
// AGENT-PUSHED-OUTSIDE-MANIFEST violation and not a gated artifact (see group M
// in tests/acceptance-gate.mjs). Both cases below declare the file they create.
// Task 178 created notes/test-success.md, committed and pushed it to
// origin/cursor-build itself. Its tree was therefore clean at guard time, and
// FIX 1 called that "no artifacts". A clean tree means "no uncommitted
// change", not "no work" - HEAD has to be compared against the pass start.
{
  const dir = makeRepo("agentcommit", { withRemote: true });
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  sh("git add -A && git commit -q -m seed && git push -q -u origin main", dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  const ex = await loadExecutor(dir);
  // The agent's own work: a real commit, not pushed by the executor.
  fs.writeFileSync(path.join(dir, "notes-test-success.md"), "test artifact\n");
  sh("git add -A && git commit -q -m 'task 178: real agent work'", dir);
  check("H0 the tree is clean after the agent's own commit (the hole's precondition)",
    sh("git status --porcelain", dir) === "", "tree still dirty");
  const pushed = await ex.pushTaskArtifacts("[S14-20] triage notes into canon\nMANIFEST: notes-test-success.md", preWorkSha, "Created `notes-test-success.md`");
  check("H1 a clean tree with HEAD moved since the pass started is treated as work",
    pushed === true, `returned ${JSON.stringify(pushed)}; reason=${ex.getLastArtifactPushReason()}`);
  check("H2 ...and the agent's commit is pushed to origin and verified",
    sh("git rev-parse origin/main", dir) === sh("git rev-parse HEAD", dir),
    `origin/main=${sh("git rev-parse origin/main", dir)} HEAD=${sh("git rev-parse HEAD", dir)}`);
  check("H3 ...and commitReachedOrigin confirms it",
    ex.commitReachedOrigin("main", dir) === sh("git rev-parse HEAD", dir), "");
  check("H4 ...so the task is 'готова', not a false 'провал'",
    ex.taskVerdictFromResult({ success: pushed === true, message: "" },
      { verdict: { fatal: false, retryable: true }, isPermanentBlock: false, retryBudgetExhausted: false }) === "готова", "");
}
{
  // The agent pushed its own commit too - the executor must not double-commit
  // and must not fail a task whose work is already on GitHub.
  const dir = makeRepo("agentpushed", { withRemote: true });
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  sh("git add -A && git commit -q -m seed && git push -q -u origin main", dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  const ex = await loadExecutor(dir);
  fs.writeFileSync(path.join(dir, "notes-test-success.md"), "test artifact\n");
  sh("git add -A && git commit -q -m 'task 178: agent work, already pushed' && git push -q origin main", dir);
  const pushed = await ex.pushTaskArtifacts("[S14-20] triage notes into canon\nMANIFEST: notes-test-success.md", preWorkSha, "Created `notes-test-success.md`");
  check("H5 work the agent already pushed itself is accepted without a second commit",
    pushed === true, `returned ${JSON.stringify(pushed)}; reason=${ex.getLastArtifactPushReason()}`);
  check("H6 ...and no duplicate commit was created",
    sh("git rev-list --count origin/main", dir) === sh("git rev-list --count HEAD", dir), "");
}
{
  // Fail-closed stays: a genuinely empty pass with a starting SHA recorded and
  // HEAD unmoved is still not an artifact. This is the fake-done path that
  // tasks 160-173 walked.
  const dir = makeRepo("nomove", { withRemote: true });
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  sh("git add -A && git commit -q -m seed && git push -q -u origin main", dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  const ex = await loadExecutor(dir);
  const pushed = await ex.pushTaskArtifacts("[S14-13] decide whether to build useDen", preWorkSha);
  check("H7 HEAD unmoved during the pass with a clean tree still fails closed",
    pushed === false, `returned ${JSON.stringify(pushed)}; reason=${ex.getLastArtifactPushReason()}`);
  check("H8 ...and the reason says HEAD did not move",
    /HEAD did not move/.test(ex.getLastArtifactPushReason() || ""), ex.getLastArtifactPushReason());
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
