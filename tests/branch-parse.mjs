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

// checkoutTaskBranch runs git against WORKDIR. On success it logs and returns
// the branch it landed on; when it cannot check out a branch the brief named,
// it THROWS (EXECUTOR-COMMIT-VERIFICATION, 2026-11-09) instead of swallowing
// the failure and staying on the default checkout - a silent fallback is how
// work ended up committed to the wrong branch with nothing in the log.
//
// This file asserts on the PARSE decision (named or not) and on the captured
// NAME. WORKDIR has neither of these refs, so every named-branch case here
// takes the throw path - and the thrown message carries the captured name,
// which is what these assertions now read. The behavioural contract change is
// why this file's expected strings were updated on 2026-11-09; the parse
// rules it covers did not change.
const CAPTURED = (text) => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let thrown = "";
  try { checkoutTaskBranch(text); } catch (e) { thrown = String(e && e.message); }
  console.log = origLog;
  return logs.join("\n") + "\n" + thrown;
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
  check("inline colon form is recognised", out.includes('"rule"') && /task named|named branch/.test(out), out.slice(0, 160));
}
{
  const out = CAPTURED("BRANCH: rule");
  check("inline colon form is case-insensitive", out.includes('"rule"') && /task named|named branch/.test(out), out.slice(0, 160));
}

// 3. The marker form, and that it wins over the inline form by position.
{
  const out = CAPTURED("[BRANCH: rule] and later branch: main");
  check("marker form wins over inline form", out.includes('"rule"') && /task named|named branch/.test(out), out.slice(0, 160));
}
{
  const out = CAPTURED("[BRANCH: main]");
  check("marker form recognised", out.includes('"main"') && /task named|named branch/.test(out), out.slice(0, 160));
}

// 4. Trailing punctuation is not part of the ref.
{
  const out = CAPTURED("branch: rule.");
  check("trailing period stripped", out.includes('"rule"') && /task named|named branch/.test(out), out.slice(0, 160));
}

// 5. The word "directive" is not a branch name.
{
  const out = CAPTURED("branch directive: see notes");
  check(`"branch directive:" is not a branch name`, out.includes("branch: none named in task text"), out.slice(0, 160));
}

// 6. A name may contain slashes and dots (refs/*, release/1.2).
{
  const out = CAPTURED("branch: release/1.2");
  check("ref with slash and dot parsed", out.includes('"release/1.2"') && /task named|named branch/.test(out), out.slice(0, 160));
}

// 7. Empty/absent text never invents a branch.
for (const t of ["", null, undefined]) {
  const out = CAPTURED(t);
  check(`absent text (${String(t)})`, out.includes("branch: none named"), out.slice(0, 160));
}

console.log(`\n=== ${failures === 0 ? "all" : failures + " failing"} branch-parse assertions ===`);
process.exit(failures === 0 ? 0 : 1);
