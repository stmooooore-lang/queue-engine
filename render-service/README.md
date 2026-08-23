# Render Service — Minimal Test for Free Tier

This service tests whether the Render free tier (512 MB RAM, 0.1 CPU) can keep a LiteLLM proxy and Cline running continuously.

## Files

- `package.json` — Node 20+, Express dependency, `start` script, `postinstall` installs Cline globally
- `server.js` — Main server:
  - Starts LiteLLM proxy as child process (`litellm --config ../cloud-config.yaml --port 4000 --host 127.0.0.1 --num_workers 1`)
  - Waits for `/health/liveliness` endpoint
  - Listens on `PORT` env var (Render requirement)
  - `GET /` → `ok`
  - `GET /test` → Runs `cline --cwd . -P openai-compatible -m plexus-act --compaction off --json "скажи одно слово: привет"`, returns last `run_result.text` as `{"answer": "..."}`
  - Creates `~/.cline/data/settings/providers.json` with exact shape from cloud-agent.yml
- `render.yaml` — Render Blueprint for one-click deploy

## Manual Deployment on Render Dashboard

If not using the Blueprint, create a **Web Service** with:

| Setting | Value |
|---------|-------|
| **Root Directory** | `render-service` |
| **Build Command** | `pip install "litellm[proxy]==1.83.9" && npm install && npm i -g cline` |
| **Start Command** | `node server.js` |
| **Environment Variables** (keys only, no values) | `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` |

These are the same keys used in `cloud-config.yaml` at the repo root.

## Local Test

```bash
cd render-service
npm install
PORT=3000 node server.js &
# Wait for "HTTP server listening on port 3000"
curl http://localhost:3000/        # → ok
curl http://localhost:3000/test    # → {"answer":"привет"} (or similar)
```

## Acceptance Criteria

Local test must pass:
- `curl /` returns `ok`
- `curl /test` returns JSON with `answer` field containing `привет` (or close equivalent)

If the test fails, the exact failure step and error will be documented in this README.