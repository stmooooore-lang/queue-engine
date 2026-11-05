/**
 * CLOUD-PUSH-UPSTREAM, 2026-11-05 - regression test for pushBranch().
 *
 * The real defect (task 155, second reason it failed): a brief named its
 * branch, dsh created that branch locally on the runner, but the remote
 * never had it. The push helper ran `git pull --rebase origin <branch>`
 * unconditionally, which dies with "couldn't find remote ref" for a branch
 * only the runner knows - and that exception took the whole task down for
 * pure git bookkeeping.
 *
 * What is asserted here:
 *   1. an existing remote branch keeps the old rebase+push path;
 *   2. a branch the remote does NOT have is CREATED with `git push -u`
 *      instead of throwing - the exact 155 failure cannot recur;
 *   3. an unsafe branch name is refused before it ever reaches a shell
 *      (names get interpolated into execSync commands);
 *   4. an unreachable repository still surfaces a real error - the "assume
 *      it exists" fallback must not mask a genuine outage as success.
 *
 * Real throwaway repositories under $TMPDIR: no network, no provenance of
 * the queue-engine repo itself is touched.
 */

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { pushBranch } from "../scripts/executor.mjs";
import path from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " :: " + extra : ""}`); }
}

const bare = mkdtempSync(path.join(tmpdir(), "push-bare-"));
const work = mkdtempSync(path.join(tmpdir(), "push-work-"));

execSync(`git init -q --bare "${bare}"`);
execSync(`git init -q "${work}"`);
execSync(`cd "${work}" && git config user.email t@t && git config user.name t && git remote add origin "${bare}" && echo hello > f.txt && git add -A && git commit -qm init && git branch -m main`);
execSync(`cd "${work}" && git push -q origin main`);

// ---- 1. a branch the remote already has keeps the rebase path.
execSync(`cd "${work}" && git checkout -qb feature-exists && echo a >> f.txt && git add -A && git commit -qm a`);
execSync(`cd "${work}" && git push -q origin feature-exists`);
execSync(`cd "${work}" && git checkout -q main && git checkout -qb feature-exists2 origin/feature-exists && echo b >> f.txt && git add -A && git commit -qm b`);
const existing = await pushBranch("feature-exists", work);
check("existing remote branch -> 'pushed' (rebase+push path preserved)", existing === "pushed", String(existing));

// ---- 2. the 155 case: local branch, no remote ref.
execSync(`cd "${work}" && git checkout -q main && git checkout -qb s14-fractal-research && echo c >> f.txt && git add -A && git commit -qm c`);
let created, err = null;
try { created = await pushBranch("s14-fractal-research", work); } catch (e) { err = e; }
check("missing remote branch -> 'created' with NO exception (task 155 cannot recur)",
  err === null && created === "created", err ? err.message : String(created));
const refs = execSync(`cd "${bare}" && git for-each-ref --format='%(refname:short)'`).toString().trim().split("\n");
check("the branch really exists on the remote afterwards", refs.includes("s14-fractal-research"), refs.join(","));

// ---- 3. branch names are interpolated into shell commands.
let err3 = null;
try { await pushBranch("main; rm -rf /", work); } catch (e) { err3 = e; }
check("unsafe branch name refused before it reaches a shell", err3 !== null && /refusing unsafe/.test(err3.message), err3 && err3.message);

// ---- 4. the assume-exists fallback must not mask an outage.
let err4 = null;
try { await pushBranch("some-branch", "/definitely/not/a/repo"); } catch (e) { err4 = e; }
check("unreachable repository still raises a real error (fallback does not fake success)",
  err4 !== null, err4 && "silently succeeded");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
