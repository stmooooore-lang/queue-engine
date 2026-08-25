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

---

## Why Disk and Memory Were Ruled Out

At the time of investigation (after the failure), the following resource checks were performed on `plexus-queue-vm`:

| Resource | Usage | Free | Verdict |
|----------|-------|------|---------|
| Root filesystem (`/`) | 69% used | 622 MB | **Healthy** — well above minimum |
| Stateful partition (`/mnt/stateful_partition`) | 33% used | 18 GB | **Healthy** — abundant space |
| Memory (RAM) | — | 675 MiB available | **Healthy** — e2-micro has 966 MiB total |

**Conclusion:** Neither disk exhaustion nor memory exhaustion caused the failure. The hypothesis that resource pressure caused docker run code 128 was **wrong** and explicitly ruled out by direct measurement on the VM.
---

## Exact Failure Mechanism

From `START-HERE.md` (lines 27–36):

> **One transient failure, cause not found, likely not systemic:** task 35 failed with `код 128: Command failed: docker run` (the container itself failed to start) and the same/similar symptom showed as "chat stopped seeing the repo". Checked the obvious causes on the VM directly and both were healthy - `/` 69% used (622M free), `/mnt/stateful_partition` 33% used (18G free), memory 675Mi available - so it was NOT disk or memory exhaustion, that hypothesis was wrong. Root cause still unknown; tasks before and after worked fine, so this reads as one transient blip, not a persistent problem. If it recurs, check `journalctl`/docker's own error text at the exact failure timestamp next, not disk/memory again.

**Observed facts:**
1. `docker run` exited with code 128 — this is Docker's "command failed to start" code (not an application error inside the container)
2. "Chat stopped seeing the repo" — Cline could not access `plexus-doc` mount
3. Both symptoms co-occurred at the same task timestamp
4. Task 34 (before) and Task 36+ (after) completed normally
5. The poller image bakes `poller.mjs` at build time (`Dockerfile.poller` line 29: `COPY scripts/poller.mjs /app/poller.mjs`) — a stale image could theoretically cause mount/config drift, but the image was confirmed fresh at the time of the post-failure verification

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