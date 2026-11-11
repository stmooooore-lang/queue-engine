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
