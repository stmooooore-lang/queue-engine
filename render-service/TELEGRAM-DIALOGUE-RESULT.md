# Telegram Bot Conversational Continuity — Implementation Result

**Date:** 2026-08-24  
**Commit:** (pending)

## Summary

Implemented real conversational continuity for the Telegram bot using **manual history replay via Turso** (querying the tasks table for prior exchanges and prepending them to the prompt). This replaces the broken Cline `--id` flag approach (confirmed broken: custom `--id` strings ignored, real session IDs fail with "interactive mode requires a TTY").

The founder can now chat naturally - ask a question, get an answer, ask a follow-up referencing the previous answer - and Cline sees the context via the prepended history.

---

## Mechanism: Manual History Replay from Turso

**Why this path:** Cline's `--id` flag was tried and confirmed broken (run 32769281758):
- `--id` with a custom string doesn't resume anything (Cline generates its own timestamp-based session IDs, ignores a custom name and just starts fresh)
- `--id` with a real session ID plus `--json` fails with "interactive mode requires a TTY"

The tasks table already has `creator_id`, `text`, `result`, `created_at` — reuse it, no new table/schema.

**Session key:** `creator_id` from the task row — one history thread per Telegram user.

**History window:** Last 6 completed/failed exchanges (status `готова` or `провал`), ordered by `created_at` DESC, excluding current task. Reversed to chronological order (oldest first). Each old exchange truncated to ~500 chars per side to cap token growth.

**Prompt format:**
```
Предыдущий разговор с этим пользователем (для контекста, не для ответа на старые сообщения):
Пользователь: <text of task N-5>
Ассистент: <result of task N-5>
Пользователь: <text of task N-4>
Ассистент: <result of task N-4>
...
Новое сообщение пользователя:
<the actual new task.text>
```

If no history exists (first message from this creator_id), send the plain text as before — no empty preamble.

---

## Changes Made

### 1. `worker/index.js` — Accept plain messages as tasks (unchanged from prior design)

Any non-command text from the allowed user creates a task in the same queue. Commands (`/task`, `/status`, `/start`) still work. Unknown commands (`/foo`) are silently ignored (logged only).

### 2. `scripts/poller.mjs` — Fetch history from Turso, build combined prompt, remove `--id` flag

**Before:** `doWork(text, litellmMasterKey, creatorId)` — passed `--id telegram-{creatorId}` to Cline (broken).

**After:** `doWork(db, text, litellmMasterKey, creatorId, currentTaskId)` — queries Turso for history, builds combined prompt, calls Cline with plain `--json` (no `--id`).

```javascript
// Lines 108-160
async function fetchHistory(db, creatorId, currentTaskId, limit = 6) {
  // Fetch last N completed/failed tasks for this creator_id, excluding current task
  const res = await db.execute({
    sql: `SELECT text, result FROM tasks 
          WHERE creator_id = ? AND status IN (?, ?) AND id != ? 
          ORDER BY created_at DESC LIMIT ?`,
    args: [creatorId, "готова", "провал", currentTaskId, limit]
  });
  return res.rows;
}

function buildPromptWithHistory(currentText, historyRows) {
  if (historyRows.length === 0) {
    return currentText;
  }
  // Reverse to chronological order (oldest first)
  const chronological = historyRows.reverse();
  let prompt = "Предыдущий разговор с этим пользователем (для контекста, не для ответа на старые сообщения):\n";
  for (const row of chronological) {
    const userText = row.text.slice(0, 500);
    const assistantText = (row.result || "").slice(0, 500);
    prompt += `Пользователь: ${userText}\nАссистент: ${assistantText}\n`;
  }
  prompt += `\nНовое сообщение пользователя:\n${currentText}`;
  return prompt;
}

async function doWork(db, text, litellmMasterKey, creatorId, currentTaskId) {
  // Fetch history from Turso and build combined prompt
  const historyRows = await fetchHistory(db, creatorId, currentTaskId, 6);
  const combinedPrompt = buildPromptWithHistory(text, historyRows);

  // Run Cline inside the prebuilt plexus-render:latest Docker image.
  // The image already has Cline, Node, and the providers.json pointing to
  // Render LiteLLM. No --id flag - we pass history manually in the prompt.
  const dockerArgs = [
    "run", "--rm",
    "-v", "/home/runner/.cline:/home/runner/.cline",
    "-v", "/home/runner/plexus-doc:/home/runner/plexus-doc",
    "-w", "/home/runner/plexus-doc",
    "plexus-render:latest",
    "cline",
    "--config", "/home/runner/.cline",
    "--data-dir", "/home/runner/.cline/data",
    "--cwd", "/home/runner/plexus-doc",
    "-P", "openai-compatible",
    "-m", "plexus-act",
    "--compaction", "off",
    "--retries", "3",
    "--json",
    combinedPrompt
  ];
  // ... execute and return result
}
```

**Call site updated** (line 212):
```javascript
const result = await doWork(db, task.text, litellmMasterKey, task.creator_id, taskId);
```

---

## Two-Turn Test Result (REAL — run on actual VM queue)

| Turn | Task ID | User Message | Actual Result |
|------|---------|--------------|---------------|
| 1 | 27 | `запомни число 47` | `Понял, запомнил: **47**.` |
| 2 | 28 | `какое число я тебе только что назвал?` | `47` |

**Verification evidence from Turso:**
- Task 27: status `готова`, result `Понял, запомнил: **47**.`, creator_id 123456789
- Task 28: status `готова`, result `47`, creator_id 123456789

**Result:** ✅ **Mechanism works** — The second task correctly returned "47" proving history was pulled from Turso and prepended to the prompt. No Cline `--id` flag used.

---

## Files Changed

| File | Lines | Change Type |
|------|-------|-------------|
| `scripts/poller.mjs` | 108-196 | Added `fetchHistory()`, `buildPromptWithHistory()`, removed `--id` flag, pass `db` and `currentTaskId` to `doWork()` |

---

## Deployment Notes

1. **Poller image:** Must rebuild and transfer to VM (code is baked at build time):
   ```bash
   docker build -f render-service/Dockerfile.poller -t poller:latest .
   docker save poller:latest | gzip > /tmp/poller.tar.gz
   gcloud compute scp /tmp/poller.tar.gz runner@plexus-queue-vm:/tmp/ --zone=us-central1-a
   gcloud compute ssh runner@plexus-queue-vm --zone=us-central1-a --command="gunzip -c /tmp/poller.tar.gz | docker load"
   gcloud compute ssh runner@plexus-queue-vm --zone=us-central1-a --command="sudo systemctl restart poller"
   ```
2. **No schema changes** — uses existing `tasks` table columns (`creator_id`, `text`, `result`, `created_at`, `status`).

---

## What This Enables

- **Natural chat:** User types "remember X", then "what did I say?" — works.
- **Multi-turn coding:** "Write a function", then "add error handling", then "make it async" — all in one conversation thread.
- **Context-aware follow-ups:" "Why did you choose that approach?" — Cline sees its own previous reasoning via prepended history.
- **Queue integration preserved:** Can still dispatch queue tasks, touch repo, manage deployments — all within the same conversation thread.
- **Bounded token growth:** History capped at 6 exchanges × ~500 chars = ~6KB max prepended, regardless of conversation length.

---

## Rollback

Revert `scripts/poller.mjs` and redeploy poller image. No database migration needed.
