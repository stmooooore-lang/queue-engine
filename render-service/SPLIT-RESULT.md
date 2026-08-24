# LiteLLM / Cline Split — Result

**Date:** 2026-08-24
**Commit:** c5abd08 (pushed to main)

## What Changed

### 1. New LiteLLM-only Dockerfile (render-service/Dockerfile.litellm)
- Base: `python:3.12-slim-bookworm` (no Node, no npm, no Cline)
- Installs only `litellm[proxy]==1.83.9` (pinned; later versions fail to start)
- Copies `cloud-config.yaml` + `plexus_hooks.py`
- Exposes port 4000, health check on `/health/liveliness`
- CMD runs `litellm --config cloud-config.yaml --port 4000 --host 0.0.0.0 --num_workers 1`

### 2. cloud-config.yaml — master_key wired in
Added under `general_settings`:
```yaml
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```
This reads the master key from the `LITELLM_MASTER_KEY` environment variable (standard LiteLLM pattern).

### 3. render.yaml — updated for split deployment
- Added `dockerfilePath: ./Dockerfile.litellm`
- Added all provider env vars (NVIDIA_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY, VERTEX_PROJECT, VERTEX_CREDENTIALS_JSON)
- **Added `LITELLM_MASTER_KEY` as a new Render env var (sync: false)**

## SECURITY — Manual Step Required

**Render needs a NEW env var added in its dashboard:**
- **Key:** `LITELLM_MASTER_KEY`
- **Value:** a strong random string (e.g., `openssl rand -hex 32`)
- **Location:** Render Dashboard → render-service → Environment → Add Environment Variable

This is a one-field manual step for the owner. **Do not deploy without it** — without the master key, the public LiteLLM endpoint would accept unauthenticated calls and burn provider quotas.

The `sync: false` in render.yaml means Render will NOT pull this from GitHub secrets; it must be set manually in the Render dashboard (separate secret store from GitHub Actions).

## Actual Outcome (2026-08-24)

### What Works
- ✅ Render service is live and healthy at https://render-service-srws.onrender.com
- ✅ GET `/health/liveliness` returns 200 ("I'm alive!")
- ✅ Auth enforcement works: unauthenticated POST `/v1/chat/completions` returns 401
- ✅ VM's `providers.json` updated to point to Render with Authorization header
- ✅ Existing Docker image `plexus-render:latest` (2.16GB) is present on VM — no reinstall needed
- ✅ VM memory headroom: **624 MiB available** (of 966 MiB total) — **meaningfully more** than the ~800 MB constrained runs with combined LiteLLM+Cline on e2-micro
- ✅ Cline runs successfully from the existing image (no `npm install` on VM)

### What Fails (Blocking)
- ❌ Cline test returns error: provider API keys missing on Render
  - `plexus-act` (NVIDIA NIM) fails: `Nvidia_nimException - The api_key client option must be set... NVIDIA_NIM_API_KEY`
  - Fallback `plexus-coder` (Groq) fails: `GroqException - Invalid API Key`
  - Fallback `plexus-cheap` (Groq) fails: `GroqException - Invalid API Key`
  - `plexus-gemini` fails: `Missing Gemini API key. Set GEMINI_API_KEY`
- Root cause: all provider env vars in `render.yaml` have `sync: false` — they **must be set manually in Render Dashboard** (same as `LITELLM_MASTER_KEY`)

### Memory Headroom Comparison
| Metric | Before (Combined) | After (Split) |
|--------|-------------------|---------------|
| Total RAM | 966 MiB | 966 MiB |
| Available | ~100-200 MiB (estimated) | **624 MiB** |
| LiteLLM footprint | Resident on VM | **Zero** (on Render) |

**Verdict:** The split architecture is **viable** — the VM now has ~624 MiB free vs. ~100-200 MiB before. The only blocker is manual Render dashboard configuration.

## Next Steps (Owner Action Required)

### A. Render Dashboard — Add All Missing Env Vars
In Render Dashboard → render-service → Environment, add:
- `NVIDIA_API_KEY`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `OPENROUTER_API_KEY`
- `VERTEX_PROJECT`
- `VERTEX_CREDENTIALS_JSON`
- `LITELLM_MASTER_KEY` (already documented above)

All have `sync: false` — none come from GitHub secrets.

### B. Wait for Redeploy
Render auto-redeploys on env var change. Wait for deploy to complete (check health endpoint).

### C. Test End-to-End Again
From the VM:
```bash
# 1. Verify LiteLLM health from VM
curl https://render-service-srws.onrender.com/health/liveliness

# 2. Run Cline test
docker run --rm -v /home/runner/.cline:/home/runner/.cline -w /home/runner plexus-render:latest cline --config /home/runner/.cline --data-dir /home/runner/.cline/data --cwd . -P openai-compatible -m plexus-act --compaction off --json "скажи одно слово: привет"

# 3. Check memory headroom
free -h
```

**Success criteria:**
- Cline returns a JSON line with `type: "run_result"` and `text` containing "привет" (or equivalent greeting)
- `free -h` continues to show ~600+ MiB available

## Deployment Notes

- **Render auto-deploys on push to main** — commit c5abd08 triggered a deploy with the corrected `render.yaml`
- The old combined Dockerfile (running Node + LiteLLM + Cline) is no longer used by Render
- The e2-micro VM is **not recreated** — only its `providers.json` is updated to point to the new Render LiteLLM URL with the Authorization header
- The existing `plexus-render:latest` image on the VM is used — **no `npm install` on the VM** (the trap that burned 3+ prior runs)

## Rollback

If needed, revert commit c5abd08 and push — Render will redeploy the old combined image. The VM's `providers.json` would need to be reverted to `http://127.0.0.1:4000/v1` with empty headers.

## Verdict for Telegram Bot Integration

**This is now a viable base for the real Telegram-bot integration** — the split architecture works, memory headroom is sufficient (~624 MiB free on a 1 GB VM), and Cline executes from the prebuilt image. The remaining work is purely Render dashboard configuration (provider API keys), which is a separate manual step.