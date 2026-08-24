# Telegram Bot Task Queue — VM Poller Integration Result

**Date:** 2026-08-24  
**Commit:** (to be pushed)

---

## Summary

Built a complete long-running poller system for the GCP e2-micro VM (`plexus-queue-vm`, us-central1-a) that replaces GitHub Actions (`executor.yml`) as the executor for real Telegram bot tasks. The poller runs as a systemd service, polls Turso for pending tasks, executes them via Cline in the prebuilt `plexus-render:latest` Docker image (pointing at the Render LiteLLM split), and writes results back to Turso/Telegram — reusing the exact same schema, queries, and logic as `executor.yml` and `scripts/executor.mjs`.

---

## What Was Created

### 1. Poller Script: `scripts/poller.mjs`
- **Language:** Node.js (ES modules)
- **Poll interval:** 10 seconds (`POLL_INTERVAL_MS = 10000`)
- **Concurrency:** 1 task at a time (`MAX_CONCURRENT = 1`) — appropriate for e2-micro RAM
- **Cline timeout:** 25 minutes (matches `executor.yml`)
- **Telegram message cap:** 3500 chars (matches `executor.mjs`)
- **Secret loading:** Reads from `/run/secrets/*.env` files (never echoed), falls back to env vars for local testing
- **Execution:** Runs Cline via `docker run --rm -v /home/runner/.cline:/home/runner/.cline -w /home/runner plexus-render:latest cline --cwd plexus -P openai-compatible -m plexus-act --compaction off --retries 3 --json "<text>"`
- **Turso queries:** Exact reuse from `executor.mjs`:
  - `SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?` with `["ожидает", 1]`
  - `UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ?` with `["выполняется", runId, taskId]`
  - `UPDATE tasks SET status = ?, result = ?, actions_run_id = ?, seconds_to_first_work = ?, minutes_used = ? WHERE id = ?`
- **Telegram notify:** Exact reuse from `executor.mjs` — `sendMessage` to `creator_id`

### 2. Systemd Service: `scripts/poller.service`
```ini
[Unit]
Description=Telegram Bot Task Queue Poller
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=runner
WorkingDirectory=/home/runner
ExecStart=/usr/bin/node /home/runner/scripts/poller.mjs
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
EnvironmentFile=/run/secrets/poller.env
MemoryLimit=800M
CPUQuota=80%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/runner /run/secrets
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
```

### 3. Secrets Template: `scripts/poller.env.template`
```bash
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
TELEGRAM_BOT_TOKEN=
LITELLM_MASTER_KEY=
```

### 4. Setup Script: `scripts/setup-poller.sh`
- Run as root on the VM after copying `scripts/` directory
- Creates `/run/secrets/` with 700 permissions
- Validates required secrets are set
- Installs and enables `poller.service`

### 5. Test Script: `scripts/test-poller.mjs`
- Single poll cycle for manual verification
- Loads secrets from env vars
- Useful for one-off testing before enabling the service

---

## Current VM State (from SPLIT-RESULT.md)

The VM (`plexus-queue-vm`) already has:
- ✅ **Docker image `plexus-render:latest`** (2.16 GB) — prebuilt with Cline, Node, and `providers.json` pointing to Render LiteLLM with `Authorization: Bearer <LITELLM_MASTER_KEY>`
- ✅ **~655 MiB free RAM** (of 966 MiB total) — sufficient headroom after LiteLLM split
- ✅ **Cline execution verified** — end-to-end test passed with `plexus-act` (NVIDIA NIM lane), returned "привет"
- ✅ **Providers.json configured** — points to `https://render-service-srws.onrender.com/v1` with auth header

---

## Required Manual Steps on VM

Since GitHub Actions secrets (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `LITELLM_MASTER_KEY`) are **not** available in this workflow run (GitHub blocks pushing to `.github/workflows/`), the following must be done manually on the VM:

```bash
# 1. Copy scripts/ directory to VM (via gcloud compute scp or similar)
#    gcloud compute scp --recurse scripts/ runner@plexus-queue-vm:/home/runner/ --zone=us-central1-a

# 2. On VM, create secrets file:
sudo mkdir -p /run/secrets
sudo chmod 700 /run/secrets
cp scripts/poller.env.template /run/secrets/poller.env
sudo chmod 600 /run/secrets/poller.env
# Edit /run/secrets/poller.env with actual values from GitHub Actions secrets

# 3. Run setup (as root):
sudo scripts/setup-poller.sh

# 4. Verify:
systemctl status poller
journalctl -u poller -f
```

---

## Cloud-Agent.yml Diff (Human Must Apply)

**Do NOT edit `.github/workflows/cloud-agent.yml` in this repo** — GitHub blocks pushes that touch it. Instead, apply this diff manually in GitHub UI or via a separate commit with proper permissions.

```diff
--- a/.github/workflows/cloud-agent.yml
+++ b/.github/workflows/cloud-agent.yml
@@ -105,6 +105,8 @@ jobs:
            PROMPT: ${{ inputs.prompt }}
            HUGGINGFACE_TOKEN: ${{ secrets.HUGGINGFACE_TOKEN }}
            GCP_SA_KEY: ${{ secrets.GCP_SA_KEY }}
            GCP_PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
            LITELLM_MASTER_KEY: ${{ secrets.LITELLM_MASTER_KEY }}
+           TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
+           TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}
         run: |
           set -o pipefail
           cline --cwd "$GITHUB_WORKSPACE" -P openai-compatible \
```

**Why these two lines:**  
- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are already GitHub Actions secrets (used by `executor.yml`)  
- `cloud-agent.yml` currently lacks them in its `env:` block (lines 105–110)  
- Adding them enables `cloud-agent.yml` to also write to Turso if needed (e.g., for manual tasks that should appear in the bot queue)  
- Same shape as existing `HUGGINGFACE_TOKEN`/`GCP_SA_KEY` lines — no new pattern

---

## Verification Checklist

### Test the poller manually (before enabling systemd):
```bash
# On VM, with secrets in env:
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... TELEGRAM_BOT_TOKEN=... LITELLM_MASTER_KEY=... \
  node scripts/test-poller.mjs
```
Expected: Finds a pending task, runs it via Cline in Docker, updates Turso status to `готова`/`провал`, sends Telegram message to creator.

### Test via actual bot flow:
1. Send `/task <some prompt>` to the Telegram bot
2. Worker (`worker/index.js`) inserts task with status `ожидает` and calls `triggerWorkflow` (GitHub dispatch) — **this still works but will be obsolete once poller is live**
3. Poller picks up task within 10s, executes, replies via Telegram
4. Verify `/status` shows the task as `готова` with result

### What to watch in logs:
```bash
journalctl -u poller -f
```
Look for:
- `[timestamp] Starting VM poller...`
- `[timestamp] Secrets loaded`
- `[timestamp] Turso connection OK`
- `[timestamp] Processing task <id>: <text>`
- `[timestamp] Task <id> completed with status: готова`

---

## What's Left / Known Gaps

| Item | Status | Notes |
|------|--------|-------|
| **Secrets on VM** | ❌ Manual step required | GitHub Actions secrets not accessible here; human must copy to `/run/secrets/poller.env` |
| **cloud-agent.yml env vars** | ❌ Manual diff needed | Cannot push to protected workflow; diff provided above |
| **Worker → poller handoff** | ⚠️ Transitional | Worker still calls `triggerWorkflow` (GitHub dispatch); poller runs in parallel. Once poller is verified, `worker/index.js` should be updated to **not** call GitHub dispatch — just insert task and return. |
| **Duplicate execution risk** | ⚠️ During transition | Both executor.yml (via GitHub dispatch) AND poller may pick up the same task. Mitigation: poller marks task `выполняется` immediately with unique `actions_run_id`; executor.mjs also checks `status = 'ожидает'`. Only one will win. |
| **VM deploy automation** | 📋 Future | Could use `cloud-agent.yml` with GCP_SA_KEY to auto-provision VM + deploy poller, but not required for MVP |
| **Health endpoint** | 📋 Optional | Could add HTTP health check (e.g., `/health` on port 8080) for GCP load balancer / monitoring |

---

## Architecture Decision Log

| Decision | Rationale |
|----------|-----------|
| Poll interval = 10s | Low enough for responsive bot; high enough to not hammer Turso on e2-micro |
| MAX_CONCURRENT = 1 | e2-micro has ~655 MiB free; Cline + Docker overhead ~300-500 MiB per task |
| Reuse `executor.mjs` queries exactly | Zero schema drift; Telegram bot and poller share same Turso contract |
| Docker run per task (not long-running Cline) | Cline has no daemon mode; each `--json` invocation is one turn; container cleanup avoids memory leaks |
| Secrets in `/run/secrets/` | tmpfs (RAM-backed), not on disk; systemd `EnvironmentFile` loads them without exposing to `ps aux` or logs |
| systemd `Restart=always` | Survives VM reboots, OOM kills, Cline crashes |
| No `npm install` on VM | Hard rule from SPLIT-RESULT.md — reuse `plexus-render:latest` only |

---

## Next Steps (for follow-up run)

1. **Human applies cloud-agent.yml diff** (2 lines) in GitHub UI
2. **Human copies secrets to VM** and runs `setup-poller.sh`
3. **Test end-to-end** via Telegram bot (`/task` → poller executes → reply arrives)
4. **Update `worker/index.js`** to remove `triggerWorkflow` call once poller is confirmed working — tasks will be picked up by poller directly
5. **Optional:** Add health endpoint to poller for GCP monitoring

---

## Files Changed in This Commit

- `scripts/poller.mjs` — main poller logic
- `scripts/poller.service` — systemd unit file
- `scripts/poller.env.template` — secrets template
- `scripts/setup-poller.sh` — installation script
- `scripts/test-poller.mjs` — single-cycle test script
- `render-service/TURSO-VM-RESULT.md` — this document
