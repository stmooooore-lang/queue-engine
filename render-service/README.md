---
sdk: docker
app_port: 7860
---

# HF Spaces Service — Minimal Test for Free Tier (Docker)

This service tests whether the Hugging Face Spaces free tier (16 GB RAM on Docker profile) can keep a LiteLLM proxy and Cline running continuously.

## Files

- `package.json` — Node 20+, Express dependency, `start` script, `postinstall` installs Cline globally
- `server.js` — Main server:
  - Starts LiteLLM proxy as child process (`litellm --config cloud-config.yaml --port 4000 --host 127.0.0.1 --num_workers 1`)
  - Waits for `/health/liveliness` endpoint
  - Listens on port 7860 (HF Spaces requirement)
  - `GET /` → `ok`
  - `GET /test` → Runs `cline --cwd . -P openai-compatible -m plexus-act --compaction off --json "скажи одно слово: привет"`, returns last `run_result.text` as `{"answer": "..."}`
  - Creates `~/.cline/data/settings/providers.json` with exact shape from cloud-agent.yml
- `Dockerfile` — HF Spaces Docker configuration (port 7860, health check, user 1000)
- `cloud-config.yaml` — LiteLLM proxy configuration with model routing
- `plexus_hooks.py` — LiteLLM proxy callback hooks

## Local Test

```bash
cd render-service
docker build -t hf-spaces-test .
docker run -p 7860:7860 -e NVIDIA_API_KEY -e GEMINI_API_KEY -e GROQ_API_KEY -e MISTRAL_API_KEY -e OPENROUTER_API_KEY -e VERTEX_PROJECT -e VERTEX_CREDENTIALS_JSON hf-spaces-test
# Wait for "HTTP server listening on port 7860"
curl http://localhost:7860/        # → ok
curl http://localhost:7860/test    # → {"answer":"привет"} (or similar)
```

## Acceptance Criteria

- `curl /` returns `ok`
- `curl /test` returns JSON with `answer` field containing `привет` (or close equivalent)
- Process stays alive without OOM kills