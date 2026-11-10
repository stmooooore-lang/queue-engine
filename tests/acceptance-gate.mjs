/**
 * PUSH-AFTER-ACCEPTANCE (BACKLOG item 3), 2026-11-10 - the Acceptance Gate.
 *
 * The founder's brief, exactly:
 *   "Перед любым пушем должна быть приёмка. Сначала локальный коммит, потом
 *    ожидание статуса 'принята', и только потом пуш в origin" - i.e. the push
 *    is released by a human decision, not by the run's own success path.
 *
 * Why the wait loop is asserted here and not by reading run(): a decision can
 * only arrive from outside the process, and the loop is the part that has to
 * survive three different inputs - accepted, rejected, and no answer at all -
 * without ever pushing in the wrong branch. run()'s own wiring (park the row,
 * wait, push, verdict) is a composition of exactly these functions.
 *
 * What is asserted, in the order the gate has to behave:
 *   I. Manifest staging - the commit contains the files the brief named and
 *      nothing else, and the commit message is readable ("task N: title").
 *   J. The gate - staging never pushes; acceptance releases the push; a
 *      rejection or a timeout rolls the work back and pushes nothing.
 *
 * Everything runs against REAL git repositories in a temp dir (no mock of git),
 * and the wait loop is driven with an injected status reader and an injected
 * sleep so the tests assert decisions, not elapsed time.
 *
 * Local-Cloud Parity: the local contour (queue.sh) has no push step at all -
 * its repo has no remote by rule - so there is no pre-acceptance push to close
 * there. What IS asserted is that the gate's statuses are not in the
 * dispatcher's SELECT, i.e. a parked task cannot be re-picked while it waits
 * (the dispatcher only picks 'ожидает' and 'провал').
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${String(detail).slice(0, 500)}`); }
}
function sh(cmd, cwd) { return execFileSync("bash", ["-lc", cmd], { cwd, stdio: "pipe" }).toString().trim(); }

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const executorPath = pathToFileURL(path.join(repoRoot, "scripts/executor.mjs")).href;
const dispatcherPath = path.join(repoRoot, "scripts/dispatcher.mjs");
let caseNo = 0;
async function loadExecutor(workdir) {
  process.env.WORKDIR = workdir;
  return import(`${executorPath}?gate=${++caseNo}`);
}
let n = 0;
function makeRepo(name, withRemote = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gate-${name}-`));
  sh("git init -q -b main . && git config user.email t@t && git config user.name t && git config commit.gpgsign false", dir);
  fs.writeFileSync(path.join(dir, "seed.md"), "seed\n");
  sh("git add -A && git commit -q -m seed", dir);
  if (withRemote) {
    // The bare origin lives OUTSIDE the work tree (${dir}.git), not inside it:
    // a .git directory inside the work tree shows up as an untracked path and
    // would make every "dirty tree" case dirty for the wrong reason.
    const bare = `${dir}.git`;
    sh(`git init -q --bare "${bare}"`, dir);
    sh(`git remote add origin "${bare}" && git push -q -u origin main`, dir);
  }
  return dir;
}

// --- I: manifest staging ----------------------------------------------------
{
  const ex = await loadExecutor(makeRepo("manifest-parse"));
  const brief = "[S14-20] triage notes into canon\nMANIFEST: notes/a.md, notes/b.md\n";
  const files = ex.artifactFileList(brief, "");
  check("I1 an explicit MANIFEST line in the brief is parsed into a path list",
    JSON.stringify(files) === JSON.stringify(["notes/a.md", "notes/b.md"]), JSON.stringify(files));
  const fromReport = ex.artifactFileList("", "I created `canon/content/x.md` and edited `canon/content/y.md`.\nPaths: canon/content/y.md");
  check("I2 without a brief manifest, the agent's report supplies the paths",
    JSON.stringify(fromReport) === JSON.stringify(["canon/content/x.md", "canon/content/y.md"]), JSON.stringify(fromReport));
  const refused = ex.artifactFileList("MANIFEST: ../outside.md, *.md, -f, ../x, notes/", "");
  check("I3 traversal, globs, option-looking tokens and directories are refused by name",
    refused.length === 0, JSON.stringify(refused));
  // A token that parses fine but names nothing (a branch or a ref quoted by the
  // agent) is not refused by the parser - it is filtered out where files are
  // actually staged, which is the point of the two-stage filter.
  const parsed = ex.artifactFileList("", "checked out `main`");
  const staged = ex.existingFilesIn(parsed, makeRepo("i3b"));
  check("I3b ...and a parsed-but-nonexistent token never reaches the commit",
    JSON.stringify(parsed) === JSON.stringify(["main"]) && staged.length === 0, `parsed=${JSON.stringify(parsed)} staged=${JSON.stringify(staged)}`);
  check("I4 the brief title comes from the brief, not from git status",
    ex.briefTitle("[NO-TRIAGE] [BRANCH: main] triage notes into canon\nMore body") === "triage notes into canon",
    ex.briefTitle("[NO-TRIAGE] [BRANCH: main] triage notes into canon\nMore body"));
}
{
  // The founder's Step 1, asserted end to end: a stray file in the work tree
  // must NOT reach the commit just because the tree is dirty.
  const dir = makeRepo("manifest-commit");
  fs.writeFileSync(path.join(dir, "wanted.md"), "the artifact\n");
  fs.writeFileSync(path.join(dir, "stray-scratch.bin"), "not in any brief\n");
  const ex = await loadExecutor(dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  process.env.TASK_ID = "181";
  const staged = ex.stageTaskArtifacts("[S14-20] triage notes into canon\nMANIFEST: wanted.md", preWorkSha, "");
  check("I5 a dirty tree with a manifest stages only the manifest",
    staged.ok === true && staged.needsGate === true, JSON.stringify(staged));
  const committed = sh("git show --name-only --format= HEAD", dir).split("\n").filter(Boolean);
  check("I6 ...so the commit holds exactly the manifest file, and the stray file is not in it",
    JSON.stringify(committed) === JSON.stringify(["wanted.md"]), JSON.stringify(committed));
  check("I7 ...and the stray file is still uncommitted in the tree (not deleted, not hidden)",
    sh("git status --porcelain", dir).includes("stray-scratch.bin"), sh("git status --porcelain", dir));
  check("I8 the commit message is 'task <N>: <brief title>'",
    sh("git log -1 --format=%s", dir) === "task 181: triage notes into canon",
    sh("git log -1 --format=%s", dir));
  check("I9 staging does NOT push: origin is still at the pass start",
    sh("git rev-parse origin/main", dir) === preWorkSha, `origin/main=${sh("git rev-parse origin/main", dir)}`);
}
{
  // A dirty tree whose manifest names nothing existing is not a commit.
  const dir = makeRepo("manifest-empty");
  fs.writeFileSync(path.join(dir, "unmentioned.md"), "work nobody named\n");
  const ex = await loadExecutor(dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  const staged = ex.stageTaskArtifacts("[S14-20] triage notes into canon", preWorkSha, "");
  check("I10 a dirty tree with no manifest match fails closed, and commits nothing",
    staged.ok === false && /no artifacts/.test(staged.reason || ""), JSON.stringify(staged));
  check("I11 ...and HEAD did not move",
    sh("git rev-parse HEAD", dir) === preWorkSha, "");
}

// --- J: the gate ------------------------------------------------------------
{
  // waitForAcceptance with an injected reader and a fake clock: the decision,
  // not the elapsed time, is what is asserted.
  const ex = await loadExecutor(makeRepo("wait"));
  let polls = 0;
  const accepted = await ex.waitForAcceptance(999, {
    deadlineMs: 1000,
    pollMs: 1000,
    sleep: async () => { polls++; },
    readStatus: async () => "принята",
  });
  check("J1 an accepted row releases the push immediately, without sleeping",
    accepted.outcome === "принята" && polls === 0, JSON.stringify(accepted));
  const rejected = await ex.waitForAcceptance(999, {
    deadlineMs: 1000, pollMs: 1000, sleep: async () => {},
    readStatus: async () => "отклонена",
  });
  check("J2 a rejected row is a decision too (no waiting for the timeout)",
    rejected.outcome === "отклонена" && /rejected/.test(rejected.reason), JSON.stringify(rejected));
  const expired = await ex.waitForAcceptance(999, {
    deadlineMs: 0, pollMs: 1000, sleep: async () => {},
    readStatus: async () => "ждёт_приёмки",
  });
  check("J3 a decision that never arrives ends in 'timeout', not in an endless loop",
    expired.outcome === "timeout" && /window expired/.test(expired.reason), JSON.stringify(expired));
  const moved = await ex.waitForAcceptance(999, {
    deadlineMs: 60000, pollMs: 1000, sleep: async () => {},
    readStatus: async () => "выполняется",
  });
  check("J4 a row that left the waiting state on its own is not waited on",
    moved.outcome === "unexpected-status", JSON.stringify(moved));
  // The reader is a plain async function, not a factory that returns one: an
  // async IIFE returns a Promise-of-a-function, and calling a Promise throws -
  // which the loop would swallow as an unreadable row and turn into a timeout.
  let reads = 0;
  let slept = 0;
  const flapping = await ex.waitForAcceptance(999, {
    deadlineMs: 60000,
    pollMs: 1000,
    sleep: async (ms) => { if (ms !== 1000) throw new Error("unexpected sleep " + ms); slept += ms; },
    readStatus: async () => (reads++ === 0 ? "ждёт_приёмки" : "принята"),
  });
  check("J5 the loop polls until the decision arrives, then stops",
    flapping.outcome === "принята" && reads === 2 && slept === 1000, JSON.stringify(flapping) + ` reads=${reads} slept=${slept}`);
}
{
  // The whole ordering, the way run() composes it: stage (nothing pushed) ->
  // decide (injected) -> push -> verify. Nothing leaves the runner before the
  // decision, and origin ends up holding exactly the committed SHA.
  const dir = makeRepo("gate-e2e");
  fs.writeFileSync(path.join(dir, "artifact.md"), "the work\n");
  const ex = await loadExecutor(dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  const staged = ex.stageTaskArtifacts("[S14-20] triage notes into canon\nMANIFEST: artifact.md", preWorkSha, "Created `artifact.md`");
  check("J6 staging parks the artifact locally and reports the branch to gate",
    staged.ok === true && staged.needsGate === true && staged.stagedSha === sh("git rev-parse HEAD", dir), JSON.stringify(staged));
  check("J7 ...and origin does not have it yet: the gate is the barrier",
    sh("git rev-parse origin/main", dir) === preWorkSha, `origin/main=${sh("git rev-parse origin/main", dir)}`);
  const decision = await ex.waitForAcceptance(999, { deadlineMs: 1000, pollMs: 1000, sleep: async () => {}, readStatus: async () => "принята" });
  const landed = await ex.pushAcceptedArtifacts(staged.branch, dir);
  check("J8 after acceptance the push happens and is verified against origin",
    /^[0-9a-f]{40}$/.test(String(landed)) && landed === staged.stagedSha, `landed=${landed}`);
  check("J9 ...so origin finally holds the artifact, and not before",
    sh("git rev-parse origin/main", dir) === staged.stagedSha, "");
}
{
  // Rejected: nothing pushed, work tree rolled back.
  const dir = makeRepo("gate-reject");
  fs.writeFileSync(path.join(dir, "artifact.md"), "the work\n");
  const ex = await loadExecutor(dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  const staged = ex.stageTaskArtifacts("[S14-20] triage notes into canon\nMANIFEST: artifact.md", preWorkSha, "");
  const decision = await ex.waitForAcceptance(999, { deadlineMs: 1000, pollMs: 1000, sleep: async () => {}, readStatus: async () => "отклонена" });
  const rolled = ex.rollbackLocalWork(preWorkSha, dir);
  check("J10 a rejected task is rolled back to the start of the pass",
    decision.outcome === "отклонена" && rolled === true && sh("git rev-parse HEAD", dir) === preWorkSha,
    `HEAD=${sh("git rev-parse HEAD", dir)} expected=${preWorkSha}`);
  check("J11 ...and origin never received anything",
    sh("git rev-parse origin/main", dir) === preWorkSha, `origin/main=${sh("git rev-parse origin/main", dir)}`);
}
{
  // Timeout: same shape, different reason.
  const dir = makeRepo("gate-timeout");
  fs.writeFileSync(path.join(dir, "artifact.md"), "the work\n");
  const ex = await loadExecutor(dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  const staged = ex.stageTaskArtifacts("[S14-20] triage notes into canon\nMANIFEST: artifact.md", preWorkSha, "");
  const decision = await ex.waitForAcceptance(999, { deadlineMs: 0, pollMs: 1000, sleep: async () => {}, readStatus: async () => "ждёт_приёмки" });
  ex.rollbackLocalWork(preWorkSha, dir);
  check("J12 a window that expires leaves the commit local and pushes nothing",
    decision.outcome === "timeout" && sh("git rev-parse origin/main", dir) === preWorkSha, JSON.stringify(decision));
}
{
  // The agent's own commit is gated too - not pushed on the executor's word.
  const dir = makeRepo("gate-agentcommit");
  fs.writeFileSync(path.join(dir, "seed2.md"), "agent work\n");
  const ex = await loadExecutor(dir);
  const preWorkSha = sh("git rev-parse HEAD", dir);
  sh("git add -A && git commit -q -m 'task 180: agent work'", dir);
  const agentSha = sh("git rev-parse HEAD", dir);
  const staged = ex.stageTaskArtifacts("[S14-20] triage notes into canon", preWorkSha, "");
  check("J13 the agent's own commit is gated exactly like an executor commit",
    staged.ok === true && staged.needsGate === true && staged.stagedSha === agentSha && /agent's own/.test(staged.source),
    JSON.stringify(staged));
  check("J14 ...and it is not pushed until the decision",
    sh("git rev-parse origin/main", dir) === preWorkSha, "");
}

// --- K: the waiting row cannot be re-picked while it waits ------------------
{
  const src = fs.readFileSync(dispatcherPath, "utf8");
  // The gate's own status is derived here rather than read from the module, so
  // this assertion does not depend on an env constant being exported.
  // Read the constant from the source, not from the module: the value has to be
  // proven to be what the executor writes, and an import of it would only prove
  // that the same module agrees with itself.
  const waitingStatus = /ACCEPT_WAITING_STATUS\s*=\s*'([^']+)'/.exec(fs.readFileSync(fileURLToPath(new URL("../scripts/executor.mjs", import.meta.url)), "utf8"))[1];
  check("K1 the gate's waiting status exists as a status the executor writes",
    waitingStatus === "ждёт_приёмки", waitingStatus);
  const selectIdx = src.indexOf("SELECT id, text, metadata, status, blocked_reason FROM tasks WHERE");
  check("K2 the dispatcher's SELECT was found", selectIdx > 0, "");
  const selectSql = src.slice(selectIdx, selectIdx + 700);
  check("K3 ...and it picks only 'ожидает' and 'провал', so a parked task is never re-picked",
    /status = 'ожидает'/.test(selectSql) && /status = 'провал'/.test(selectSql) && !selectSql.includes(waitingStatus),
    selectSql.slice(0, 300));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
