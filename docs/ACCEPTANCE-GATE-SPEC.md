# ACCEPTANCE-GATE-SPEC — how a repo publishes work only after the founder says so

Status: standard, effective 2026-11-10 (founder's brief: "механизм приёмки — это
стандарт для всех проектов"). Source implementation: `queue-engine`
(`scripts/executor.mjs` acceptance gate + `scripts/accept-pending.mjs` +
`.github/workflows/merge-pending.yml`). This file is the adoption contract: a repo
that follows it publishes nothing before acceptance, and the founder's only
action is a status change.

## 1. Principle

**The founder only changes the task's status to `принята`. Everything else —
merge, push, branch cleanup, closing the row — is done by the robot.**

The reason this shape exists at all: an ephemeral CI runner dies with whatever it
has not pushed, so a commit waiting between runs is not waiting, it is gone. The
gate therefore parks the work somewhere durable (`pending/task-<id>`), waits for
a decision, and publishes only when the decision arrives. A decision that is a
silence (an expired window) is not treated as a rejection: the work is preserved
and nobody is told `провал` for not having answered yet.

## 2. What to copy into your repo

| File | Role | Edits allowed |
| --- | --- | --- |
| `scripts/accept-pending.mjs` | merges one accepted task: fetch `pending/task-<id>` → `git merge --no-ff` → push → verify → close the row → retire the pending ref | Do not weaken: the `принята` check, the `--no-ff` merge, the push verification. |
| `.github/workflows/merge-pending.yml` | cron `*/5`, finds accepted rows and runs the script per task | `vars.TARGET_REPO` only. |

Both files are portable: they take the task id, the target repo path and the
target branch as arguments, and read Turso credentials from the environment.

## 3. What to configure

Secrets (Settings → Secrets and variables → Actions in your repo):

- `TURSO_URL` — the database URL (the script accepts `TURSO_DATABASE_URL` too).
- `TURSO_TOKEN` — the auth token (the script accepts `TURSO_AUTH_TOKEN` too).
- `REPO_TOKEN` (already required by the queue's own workflows) — a token with
  write access to the repo the tasks run in.
- `TURSO_URL` must be the same database `scripts/executor.mjs` writes to; a gate
  wired to a different database accepts nothing.

Variables (optional): `vars.TARGET_REPO` — `owner/name` of the repo tasks are
executed in, if it is not the default in the workflow.

## 4. How it works

1. The executor finishes a task and commits its artifacts **locally only**
   (staging is strictly from a manifest, `git add -A` is not used).
2. Acceptance starts: the row becomes `ждёт_приёмки`, the founder is notified,
   and the work is committed but not pushed.
3. One of three endings:
   - **`принята`** → the commit is pushed to the task's target branch, verified
     against origin (`commitReachedOrigin`), and the row becomes `готова`.
   - **`отклонена`** → the local commit is rolled back, the row becomes
     `провал_фатальный`. A rejection is a decision, so the work is destroyed.
   - **window expires** → the commit is pushed to its own ref
     `pending/task-<id>` (never to the target branch), the row becomes
     `ждёт_приёмки_просрочено`, and `metadata.pending_branch` /
     `metadata.target_branch` record where it went. The dispatcher never picks
     that status, so nothing re-runs it.
4. The founder decides for an overdue task by setting the row to `принята`.
   Within 5 minutes `merge-pending.yml` merges `pending/task-<id>` into the
   target branch with `--no-ff` (so the acceptance leaves a visible node in
   history), pushes, verifies the push, closes the row as `готова`, and deletes
   the pending ref.
5. A merge conflict stops the run: `MERGE-CONFLICT`, nothing pushed, nothing
   closed, and the row still says `принята`. The founder resolves it (rebase the
   pending branch onto the target, or re-run the brief) — the script does not
   resolve conflicts on its own.

## 5. How to request an adoption

If you are reading this in another repo: **ask the founder to initiate the
adoption against this spec** — do not invent a local variant. The gate is one
mechanism across projects by design (Local-Cloud Parity, `AGENTS.md`), and a
per-repo variant is how the two stop agreeing.

Adoption is a short, checkable list:

1. Copy the two files from §2.
2. Set the three secrets from §3.
3. Have `scripts/executor.mjs` write `metadata.pending_branch` and
   `metadata.target_branch` when it parks a task (the workflow selects on them).
4. Confirm the cron run finds the row: `node scripts/list-accepted-pending.mjs`
   must print nothing while no task is accepted, and the task id once the founder
   sets `принята`.

## 6. What this spec does NOT do

- It does not merge into a branch the task did not work on: the target branch
  comes from the brief (`[BRANCH: x]`) and lands in `metadata.target_branch`.
- It does not push anything on a rejection, or on a failed preservation attempt;
  the row then says the work is gone, and a human decides.
- It does not resolve merge conflicts, and it does not delete a target branch.
- It does not authorise an agent's own commit: the agent may commit, but the
  files must be declared in the brief's `MANIFEST:`/`FILES:` lines, else the task
  fails with `AGENT-PUSHED-OUTSIDE-MANIFEST` and the work is rolled back. (An
  agent running under `danger-full-access` can push on its own; this is the
  boundary that stops that from becoming an unpublished publication.)

## 7. Acceptance of this spec in a repo

The gate is live when: a task can reach `ждёт_приёмки`, the founder setting
`принята` publishes it without any other human action, the cron handles a
`принята` row by itself, and a conflict leaves the target branch untouched.
Tests for the implementation: `queue-engine/tests/acceptance-gate.mjs` (the gate),
`queue-engine/tests/accept-pending.mjs` (the merge script).
