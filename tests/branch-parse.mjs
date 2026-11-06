/**
 * ZOMBIE-HOTFIX, 2026-11-08 - regression test for the task-branch parser.
 *
 * THE BUG IT PINS: the old regex was /\bbranch[:\s]+.../i, which accepted ANY
 * whitespace after the word "branch". So the sentence "branch is main"
 * captured "is" as a branch name, the run then tried `git fetch origin is`,
 * failed, and silently fell back to the default checkout - a task's stated
 * intent lost with no error anyone could see.
 *
 * THE FIX: a branch is an explicit token, not prose. Two forms only, colon
 * mandatory:
 *   [BRANCH: name]   (marker - wins when both are present)
 *   branch: name     (inline)
 * No looser matching, and deliberately no Russian "ветка:" alias: an
 * unrequested alias in a ref parser is a guess, and a guess there is a
 * checkout of a ref nobody asked for.
 *
 * The function is tested through its real invocation context (the exported
 * symbol), not a copy of the regex - a copy of the pattern tests only the
 * copy, which is exactly how the previous SQL fix appeared not to take.
 */
import { checkoutTaskBranch } from "../scripts/executor.mjs";

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS  ${name}`); return; }
  failures += 1;
  console.log(`FAIL  ${name} :: ${detail}`);
}

// checkoutTaskBranch runs git against WORKDIR; it logs and returns the actual
// current branch on success, or null when nothing is named / checkout failed.
// We assert on the PARSSE decision (named or not) via the log line contract,
// and on the captured name for the forms that must succeed - none of which
// can reach git here, because WORKDIR has neither of these refs. That last
// part is the point: capture "is" and the log proves a checkout was attempted.
const CAPTURED = (text) => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try { checkoutTaskBranch(text); } catch (e) { /* git failures are swallowed by the fn */ }
  console.log = origLog;
  return logs.join("\n");
};

// 1. The reported defect: prose must NOT be read as a branch name.
for (const prose of [
  "branch is main",
  "ветка main please",
  "the branch feature-x is where it lives",
  "use branch staging for this",
]) {
  const out = CAPTURED(prose);
  check(`prose is not a branch name: ${JSON.stringify(prose)}`,
    out.includes("branch: none named in task text"), out.slice(0, 160));
}

// 2. The colon form must be honoured (the only inline form).
{
  const out = CAPTURED("деплой, branch: rule");
  check("inline colon form is recognised", out.includes('branch: task named "rule"'), out.slice(0, 160));
}
{
  const out = CAPTURED("BRANCH: rule");
  check("inline colon form is case-insensitive", out.includes('branch: task named "rule"'), out.slice(0, 160));
}

// 3. The marker form, and that it wins over the inline form by position.
{
  const out = CAPTURED("[BRANCH: rule] and later branch: main");
  check("marker form wins over inline form", out.includes('branch: task named "rule"'), out.slice(0, 160));
}
{
  const out = CAPTURED("[BRANCH: main]");
  check("marker form recognised", out.includes('branch: task named "main"'), out.slice(0, 160));
}

// 4. Trailing punctuation is not part of the ref.
{
  const out = CAPTURED("branch: rule.");
  check("trailing period stripped", out.includes('branch: task named "rule"'), out.slice(0, 160));
}

// 5. The word "directive" is not a branch name.
{
  const out = CAPTURED("branch directive: see notes");
  check(`"branch directive:" is not a branch name`, out.includes("branch: none named in task text"), out.slice(0, 160));
}

// 6. A name may contain slashes and dots (refs/*, release/1.2).
{
  const out = CAPTURED("branch: release/1.2");
  check("ref with slash and dot parsed", out.includes('branch: task named "release/1.2"'), out.slice(0, 160));
}

// 7. Empty/absent text never invents a branch.
for (const t of ["", null, undefined]) {
  const out = CAPTURED(t);
  check(`absent text (${String(t)})`, out.includes("branch: none named"), out.slice(0, 160));
}

console.log(`\n=== ${failures === 0 ? "all" : failures + " failing"} branch-parse assertions ===`);
process.exit(failures === 0 ? 0 : 1);
