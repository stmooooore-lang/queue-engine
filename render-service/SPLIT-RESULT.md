# LiteLLM / Cline Split — Result

**Date:** 2026-08-23
**Commit:** 79bba8a (pushed to main)

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

## Next Steps (Owner Action Required)

### A. Render Dashboard
1. Wait for auto-deploy to trigger from this push (Render auto-deploys on push to main).
2. Add `LITELLM_MASTER_KEY` env var in Render Dashboard → render-service → Environment.
3. Redeploy (or wait for auto-redeploy on env var change).
4. Note the public URL: `https://render-service.onrender.com` (or whatever Render assigns).

### B. e2-micro VM (plexus-queue-vm, us-central1-a)
SSH into the existing VM and update Cline's provider config:

**File:** `~/.cline/data/settings/providers.json`

**Change `baseUrl` and add `headers`:**
```json
{
  "version": 1,
  "lastUsedProvider": "openai-compatible",
  "providers": {
    "openai-compatible": {
      "settings": {
        "provider": "openai-compatible",
        "apiKey": "not-used-by-the-local-proxy",
        "model": "plexus-act",
        "baseUrl": "https://<RENDER-SERVICE-URL>/v1",
        "headers": {
          "Authorization": "Bearer <LITELLM_MASTER_KEY_VALUE>"
        }
      },
      "updatedAt": "<current-iso-timestamp>",
      "tokenSource": "migration"
    }
  }
}
```

Replace `<RENDER-SERVICE-URL>` with the actual Render service URL (e.g., `render-service.onrender.com`) and `<LITELLM_MASTER_KEY_VALUE>` with the same value you put in Render's `LITELLM_MASTER_KEY` env var.

### C. Test End-to-End
From the VM:
```bash
# 1. Verify LiteLLM health from VM
curl https://<RENDER-SERVICE-URL>/health/liveliness

# 2. Run Cline test (equivalent to old /test)
cline --cwd . -P openai-compatible -m plexus-act --compaction off --json "скажи одно слово: привет"

# 3. Check memory headroom
free -h
```

**Success criteria:**
- Cline returns a JSON line with `type: "run_result"` and `text` containing "привет" (or equivalent greeting)
- `free -h` shows **meaningfully more available memory** than the ~800 MB constrained runs before (LiteLLM's static footprint — Python interpreter + deps, a few hundred MB — is no longer resident on the 1 GB e2-micro)

## Deployment Notes

- **Render auto-deploys on push to main** — this push (commit 79bba8a) will trigger a new deploy automatically.
- The old combined Dockerfile (running Node + LiteLLM + Cline) is no longer used by Render.
- The e2-micro VM is **not recreated** — only its `providers.json` is updated to point to the new Render LiteLLM URL with the Authorization header.

## Rollback

If needed, revert commit 79bba8a and push — Render will redeploy the old combined image. The VM's `providers.json` would need to be reverted to `http://127.0.0.1:4000/v1` with empty headers.