# Postmortem: Task 35 Failure (docker run code 128 + agent lost repo access)

**Date:** 2026-08-24 (inferred from START-HERE.md context)
**Task ID:** 35
**Status:** Transient failure, root cause undetermined, likely not systemic

---

## Summary

Task 35 failed with exit code 128 from `docker run` (container failed to start) and the symptom "chat stopped seeing the repo" appeared simultaneously. Both symptoms occurred at the same timestamp. Tasks immediately before and after task 35 completed successfully.

---

## Root Cause

**Undetermined.** The failure was transient and did not recur. No persistent infrastructure defect was found.

**Evidence from START-HERE.md (lines 27-36):**
- Task 35 failed with `код 128: Command failed: docker run` (container failed to start)
- Same timestamp: "chat stopped seeing the repo" — Cline could not access `plexus-doc` mount
- Direct measurement on `plexus-queue-vm` ruled out disk/memory pressure:
  - Root filesystem (`/`): 69% used (622 MB free) — **Healthy**
  - Stateful partition (`/mnt/stateful_partition`): 33% used (18 GB free) — **Healthy**
  - Memory (RAM): 675 MiB available — **Healthy** (e2-micro has 966 MiB total)
- Task 34 (before) and Task 36+ (after) completed normally
- Poller image bakes `poller.mjs` at build time (`Dockerfile.poller` COPY) — image was confirmed fresh post-failure

**What code 128 means in Docker:**
- Exit code 128 = `128 + signal` where signal = 0 (not a signal)
- Typically: Docker daemon could not start the container (mount failure, image pull failure, OOM kill before exec, cgroup error, etc.)
- NOT an application exit code from inside the container
---

## Guard Rule to Prevent Recurrence

Since the root cause is unknown and the failure was transient, the guard rule must **detect** the symptom class (docker run failure + repo access loss) and **recover automatically**, not prevent a specific cause.

### Concrete Guard Rule: Poller Health-Check with Docker Run Retry + VM Watchdog

Add to `scripts/poller.mjs` (in the `doWork` function, around the `docker run` call):

```javascript
// Retry docker run on transient failures (exit code 128, 125, 126, 127)
// Max 2 retries with exponential backoff (5s, 15s)
const DOCKER_RUN_RETRIES = 2;
const DOCKER_RETRY_BASE_MS = 5000;

async function runClineWithRetry(dockerArgs, maxRetries = DOCKER_RUN_RETRIES) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { stdout, stderr } = await execFile("docker", dockerArgs, {
        timeout: CLINE_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
      });
      return { success: true, stdout, stderr };
    } catch (err) {
      lastError = err;
      const code = err.code ?? err.signal ?? "?";
      
      // Retry on transient Docker daemon errors
      const transientCodes = ["125", "126", "127", "128", "ENOENT", "ECONNREFUSED"];
      const isTransient = transientCodes.includes(String(code));
      
      if (attempt < maxRetries && isTransient) {
        const delay = DOCKER_RETRY_BASE_MS * Math.pow(3, attempt); // 5s, 15s
        console.log(`[${new Date().toISOString()}] docker run failed with code ${code} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      // Non-transient or retries exhausted
      throw err;
    }
  }
  
  throw lastError;
}
```

### Systemd Watchdog (in `poller.service`)

Add to the `[Service]` section:

```ini
# Watchdog: if poller stops writing to journal for 60s, systemd restarts it
WatchdogSec=60
Restart=always
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5
```

The poller must then call `sd_notify(0, "WATCHDOG=1")` periodically (every 20s) from the poll loop. Since this is a Node.js process, use the `sd-notify` npm package or write to `$NOTIFY_SOCKET` directly.

### Poll Loop Heartbeat (add to `pollLoop`)

```javascript
// Heartbeat for systemd watchdog
const WATCHDOG_INTERVAL_MS = 20000;
let lastWatchdog = 0;

async function pollLoop(db, botToken, litellmMasterKey) {
  while (true) {
    try {
      // ... existing poll logic ...
      
      // Watchdog ping
      const now = Date.now();
      if (now - lastWatchdog >= WATCHDOG_INTERVAL_MS) {
        // Write to systemd notify socket if available
        if (process.env.NOTIFY_SOCKET) {
          const notifySocket = process.env.NOTIFY_SOCKET;
          const msg = Buffer.from("WATCHDOG=1");
          const dgram = require("node:dgram");
          const sock = dgram.createSocket("unix_dgram");
          sock.send(msg, 0, msg.length, notifySocket);
          sock.close();
        }
        lastWatchdog = now;
      }
    } catch (err) {
      // ... existing error handling ...
    }
  }
}
```

---

## Verification Checklist for Guard Rule Deployment

| Check | Command | Expected |
|-------|---------|----------|
| Poller image rebuilt with retry logic | `docker build -f render-service/Dockerfile.poller -t poller:latest .` | Success |
| Image transferred to VM | `docker save poller:latest \| gzip > /tmp/poller.tar.gz` + scp + load | `Loaded image: poller:latest` |
| Systemd unit updated with WatchdogSec | `gcloud compute ssh ... -- 'cat /etc/systemd/system/poller.service'` | `WatchdogSec=60` present |
| Service restarted | `sudo systemctl daemon-reload && sudo systemctl restart poller` | Active, recent timestamp |
| Test task submitted | Insert task via Turso | Task completes, no code 128 |
| Simulated failure (kill container mid-run) | `docker kill <task-container>` | Poller retries, task eventually succeeds or fails cleanly |

---

## Notes

- This postmortem was written from documented evidence in `plexus-doc/canon/START-HERE.md` and `render-service/TURSO-VM-RESULT.md` — no live SSH to the VM was possible from this environment (GitHub Actions runner).
- The exact timestamp of task 35 is not in the local Turso database; it exists only in the production Turso instance on the VM.
- If this failure recurs, the immediate next step is `journalctl -u poller --since='<exact-failure-time>' --until='<exact-failure-time+5m>'` and `journalctl -u docker --same-window` on the VM to capture Docker daemon's own error text.
- **Correction:** The task description stated "Neither has sendRichMessage/RichBlockTable" — both branches currently have this implementation (added 2026-08-25, documented in `plexus-doc/notes/2026-08-25-telegram-rich-tables.md`).

---

## Current Telegram Formatting State (2026-08-25)

### Comparison: `main` vs `cursor-build` (HEAD)

| Feature | `main` (HEAD) | `cursor-build` | Status |
|---------|---------------|----------------|--------|
| **parse_mode** | HTML (`"HTML"`) | HTML (`"HTML"`) | ✅ Same |
| **markdownToTelegramHTML()** | Present (hand-written) | Present (hand-written) | ✅ Same |
| **sendRichMessage()** | Present (lines 205-211) | Present (lines 205-211) | ✅ Same |
| **RichBlockTable support** | Present via `messageToRichBlocks()` | Present via `messageToRichBlocks()` | ✅ Same |
| **containsMarkdownTable()** | Present (line 113) | Present (line 113) | ✅ Same |
| **parseMarkdownTable()** | Present (line 120) | Present (line 120) | ✅ Same |
| **markdownToRichText()** | Present (line 170) | Present (line 170) | ✅ Same |
| **messageToRichBlocks()** | Present (line 185) | Present (line 185) | ✅ Same |
| **notifyTelegram routing** | Table → sendRichMessage, else HTML | Table → sendRichMessage, else HTML | ✅ Same |
| **Rate limiter** | Not present | Not present | ✅ Not needed |

**Key finding:** The task description claimed "Neither has sendRichMessage/RichBlockTable" — this is **incorrect**. Both branches (which are currently identical at HEAD) already contain the full `sendRichMessage`/`RichBlockTable` implementation added in the 2026-08-25 session (documented in `plexus-doc/notes/2026-08-25-telegram-rich-tables.md`).

**Current implementation flow in `notifyTelegram`:**
1. `containsMarkdownTable(message)` — detects `|---|` markdown table syntax
2. If table: `messageToRichBlocks()` → `sendRichMessage()` (Telegram Bot API `sendRichMessage` with `RichBlockTable`)
3. On sendRichMessage failure: falls back to `sendMessage` with HTML mode
4. If no table: `splitForTelegram()` → `sendOneTelegramMessage()` with `markdownToTelegramHTML()` + `parse_mode: "HTML"`

---

## Concrete Next Steps for Stable Poller + Readable Telegram Messages

### Step 1: Add Docker Run Retry for Transient Failures (exit codes 125, 126, 127, 128)
**Rationale:** Task 35's exit code 128 was a transient Docker daemon error. A retry wrapper with exponential backoff will auto-recover from such blips without manual intervention.

**Acceptance check:**
```bash
# Verify retry logic exists in doWork() around the docker run call
grep -n "runDockerWithRetry\|DOCKER_RETRY_BASE_MS\|transientCodes" scripts/poller.mjs
# Expected: function definition + usage in doWork
```

### Step 2: Add Systemd Watchdog to Poller Service
**Rationale:** If the poller process hangs (e.g., Docker daemon wedge), systemd will auto-restart it within 60s.

**Acceptance check:**
```bash
# Verify WatchdogSec in poller.service
grep -n "WatchdogSec\|Restart=always" render-service/poller.service 2>/dev/null || grep -n "WatchdogSec\|Restart=always" scripts/poller.service
# Expected: WatchdogSec=60, Restart=always, RestartSec=10
```

### Step 3: Verify Live Telegram Rendering (Tables + HTML)
**Rationale:** Confirm the `sendRichMessage`/`RichBlockTable` path works end-to-end and HTML fallback is solid.

**Acceptance check:**
```bash
# Insert a test task with a markdown table via Turso
# Expected: Telegram renders native table (RichBlockTable), not raw markdown
# Verify in poller logs: "sendRichMessage" path taken, not fallback
grep -E "sendRichMessage|containsMarkdownTable" /var/log/syslog | tail -5
```