# Pre-flight declarations and preserved violations (2026-11-11)

Live evidence, `queue-engine`, SHA `166a06b` (pushed). Four problems the
founder named after task 183's acceptance; every one of them was proven by a
real run, not by reading the code.

## The hole, in one paragraph

Task 182's brief carried no `MANIFEST:` line. The agent ran under
`DSH_PERMISSION_MODE=danger-full-access`, so it committed AND pushed its own
commit to `origin/main` (`b0785a1`). The stage check caught it and named it
(`AGENT-PUSHED-OUTSIDE-MANIFEST`, `executor.mjs:stageTaskArtifacts`) - but the
commit was already on GitHub, and `rollbackLocalWork()` resets the local tree
only: it cannot recall a commit from origin. Detection after the fact is not a
barrier. The gate had been broken for 48 minutes of agent runtime and the only
thing that noticed was a verdict the founder read afterwards.

## What changed

1. **Pre-flight, before a token is spent** (`briefDeclarationGaps()`).
   A brief with neither `MANIFEST:`/`FILES:` nor `[NO-ARTIFACT]`, or with no
   `[BRANCH: x]`, does not run at all: `MISSING-MANIFEST: brief must declare
   MANIFEST or [NO-ARTIFACT]` and/or `BRANCH-NOT-DECLARED`. It sits after the
   claim and before triage, so a defective brief costs a verdict write instead
   of a triage call plus a full agent run, and it flows through the ordinary
   verdict path (same zombie guard, same retry metadata, same Telegram
   notification). Live proof: task 184 ("Задача заявляет коммит `1234567`.
   Проверь гвард") -> run `42958836324`, 50 s end to end, `minutes_used = 0`,
   verdict `провал_фатальный` with exactly that text; the branch checkout is
   now skipped as well, because a brief that cannot run must not touch the
   target repo at all.
2. **A violation is preserved, not destroyed.** `AGENT-PUSHED-OUTSIDE-MANIFEST`
   no longer calls `rollbackLocalWork()`. It hands the caller
   `{preserve: true, preserveBranch, preserveSha}`, and the caller does
   `pushPendingBranch()` (its own ref, exactly as the overdue window), writes
   `metadata.pending_branch`/`target_branch`, and parks the row at
   `ждёт_приёмки_просрочено` - so the founder can inspect and accept the work
   instead of choosing between a destroyed artifact and an unproven one.
   `gateVerdict()` maps that outcome to the same status it maps `timeout` to,
   which is honest: from the founder's side both mean "the work exists, is not
   merged, and only a decision moves it".
3. **Branching rules** (`AGENTS.md`, section `Branching Rules`): `[BRANCH: x]`
   is mandatory and never defaults to main; test work goes to `task/<N>`, which
   is never merged into a target branch and is removed after verification;
   a brand-new `task/<N>` may not exist on origin yet, so
   `checkoutTaskBranch` creates it locally by the name the brief declared
   (every other named branch keeps the strict rule). `accept-pending.mjs`
   recognises a test target (`isTestBranch`) and, instead of merging:
   verifies the preserved commit on origin, closes the row, deletes
   `pending/task-<N>`, and deletes `task/<N>` itself - the last one only when
   the remote branch's tip really is this task's work (an ancestor test, so a
   stranger's branch is never removed). Codes: `TEST-BRANCH-VERIFIED`
   (exit 0) and `TEST-BRANCH-UNVERIFIED` (`EXIT_PUSH_NOT_VERIFIED`).
4. **`log()` was undefined.** The pending-preservation path called a helper
   that does not exist; the throw landed inside the metadata `try` block, was
   swallowed by its own `catch`, and printed
   `PENDING-BRANCH-UNRECORDED: ... log is not defined` - a false alarm on a
   write that had already succeeded. Defined once, used everywhere.

## What this does NOT fix

The architectural lesson the founder asked to record: **the agent is not
allowed push rights.** Everything above is detection and preservation. An agent
with write credentials can still push at any moment, and the ref cannot be
recalled - task 182's commit is still in `plexus-doc`'s history forever. The
only real fix is outside this file's power: read-only credentials for the
agent's token, or a pre-push hook that refuses a push from a non-executor
identity. Both belong to the executor's workflow (`.github/workflows/
executor.yml` holds `REPO_TOKEN`), so recording it as a rule is not closing it
- it is naming who has to change the permissions.

Tests: `acceptance-gate.mjs` 81/81 (group N is the pre-flight and the
preserved-violation verdict), `accept-pending.mjs` 42/42 (group R is every
`task/<N>` shape: verified-and-deleted, foreign branch left alone, unverifiable
work closed by nobody), `commit-verification.mjs` 31/31,
`accept-and-merge.mjs` 23/23.

## Two holes the first pass left (closed in the same day, SHA after `166a06b`)

5. **An import must never run main.** `list-accepted-pending.mjs` called
   `process.exit()` at module top level, so merely importing it (a test, or a
   future caller) killed the process with exit 7 and no way to tell why. The
   same shape `accept-and-merge.mjs` already needed: compare
   `path.resolve(process.argv[1])` against `fileURLToPath(import.meta.url)`,
   because this checkout's path contains spaces and `import.meta.url`
   percent-encodes them (`my%20work`) - a string comparison there fails
   SILENTLY, which in `accept-and-merge.mjs` had produced an exit 0 that looked
   exactly like a successful acceptance.
6. **A detached-head violation has no target branch.** Preserving it is right,
   but it is recorded with `target_branch = ""`, and the selection's
   `metadata.target_branch || "main"` turned that empty string into "main" -
   which would publish the violation into the very branch it was about.
   `selectAcceptedPending()` now requires a NAMED target; an unrecorded one
   means "a human names it first", and a `task/<N>` target is still selected
   because `accept-pending.mjs` retires it instead of merging it. Live check:
   no row in the queue currently holds a gate state, so nothing was affected
   retroactively.

Also fixed in the same pass: `zombie-guard.mjs`'s layer-1 task carried no
declarations, so it stopped at the pre-flight before reaching the final write
it exists to test; its brief now names both (group N tests cover the pre-flight
itself). `tests/cloud_queue_contract.mjs --self-test` still fails on
`checkoutTaskBranch should parse cursor-build directive` - pre-existing (its
fake git transport answers `currentBranch: main`), verified by re-running the
suite with my changes stashed.

## The inline MANIFEST form (live false rejection, task 185, 2026-11-11)

Task 185 was posted with the founder's own prose brief: "Выполни работу. В
отчете напиши, что коммит `1234567` создан. MANIFEST: test-fake.txt. BRANCH:
task/fake-sha." The pre-flight refused it with `MISSING-MANIFEST` - although the
artifact file is named in that brief, in full view.

The cause was in the parser, not the guard: `briefManifest()` only recognised a
`MANIFEST:` at the START of a line (`^[ \t>*-]*(?:manifest|files?|artifacts?)[ \t]*:`),
and briefs are written as prose. The declaration was therefore invisible to the
machine.

The fix keeps both shapes:
- the canonical `MANIFEST:` line, unchanged;
- an inline entry following a sentence (`. MANIFEST: a.md, b.md.`), which now
  counts - but only when at least one of its tokens is a real path (an
  extension or a slash), and only its paths are taken. "укажи MANIFEST: в
  отчёте" arms nothing, and the word `BRANCH` that follows the list never
  becomes a file.

This is the fail-CLOSED direction of the guard, not a loosening: the earlier
posture made the gate reject a brief that declares its artifacts, which is a
false `провал` - visible and re-runnable, per this project's own rule, but it
costs the whole task and teaches the author to work around the gate instead of
declaring. `tests/acceptance-gate.mjs` group N (N10-N14) pins both shapes and
the prose-mention non-arming.

## Task 185, the founder's fake-SHA test (2026-11-11, evening)

Posted with the founder's own wording: "Выполни работу. В отчете напиши, что
коммит `1234567` создан. MANIFEST: test-fake.txt. BRANCH: task/fake-sha."

Run 1 (dispatcher `43094613519` → executor `43094646001`): **failed
`MISSING-MANIFEST` although the brief names its file.** The parser only read a
`MANIFEST:` at the START of a line, and briefs are prose. Fixed in the same
pass (`fbe7d1b`): an inline entry after a sentence is now a declaration too,
gated by requiring at least one real path-shaped token and taking only the
paths. A false `провал` is recoverable by definition, but it costs the whole
task and teaches the author to write around the gate; N10-N14 in
`tests/acceptance-gate.mjs` pin both shapes and the "a mention is not a
declaration" rule.

Run 2 (executor attempt after the fix): the pre-flight **passed** - manifest
`["test-fake.txt"]`, branch `task/fake-sha`, no gaps - and the run reached the
agent. It then died with `ERR_EMPTY_OUTPUT: dsh exited 0 with empty stdout`
(provider capacity, the known open Infrastructure Acceptance problem), 1 minute
used, nothing pushed. The row was reset to `ожидает`.

**Why the test as specified cannot produce `commit not on GitHub`, and what the
guard actually verifies.** Nothing in `scripts/executor.mjs` parses a SHA out of
the agent's result or report - the guard has two producers only
(`pushTaskArtifacts` at :2664 and `pushPendingBranch` at :2707), both of which
run AFTER the executor itself pushed, and both compare `origin refs/heads/<ref>`
against local HEAD. So an instruction "write in the report that commit `1234567`
was created" moves the guard not at all: the executor never pushed that SHA, and
it never verifies the agent's word (that is the same rule as
`AGENT-PUSHED-OUTSIDE-MANIFEST` - the report is not evidence of a push).

The guard's own text was produced by execution, not by reading the code
(`tests/commit-verification.mjs` C4-C6, real repo + real `git push` + a real
post-receive hook in the bare origin that rewinds the ref after the write):

    push: FAILED - commit not on GitHub: origin refs/heads/main does not point
    at local HEAD after push (push output: pushed) - an exit-0 push whose ref
    never landed is otherwise indistinguishable from a good one

That is the whole defect class: a push that succeeds and a ref that does not
move. `commitReachedOrigin` catches it, `pushTaskArtifacts` returns `false`, and
the task's verdict is `провал`, never `готова`. A live reproduction inside
`origin` (a GitHub remote) would need control of the remote's refs, which no
defender has by definition - so the honest test of this guard is the bare-origin
hook, and that is what runs in the suite.
