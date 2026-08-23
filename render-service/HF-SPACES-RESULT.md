# HF Spaces Deployment Result

## Status: FAILED — HUGGINGFACE_TOKEN not available in runner environment

### Error Details
The `HUGGINGFACE_TOKEN` environment variable is **not present** in the GitHub Actions runner environment. Neither `HUGGINGFACE_TOKEN` nor `HF_TOKEN` are set.

```
Available environment variables (filtered for tokens):
- No HUGGINGFACE_TOKEN found
- No HF_TOKEN found
```

**Evidence:**
```bash
$ python3 -c "import os; print('HUGGINGFACE_TOKEN:', os.environ.get('HUGGINGFACE_TOKEN')); print('HF_TOKEN:', os.environ.get('HF_TOKEN'))"
HUGGINGFACE_TOKEN: None
HF_TOKEN: None
```

The user indicated this token was added as a GitHub repository secret at `https://github.com/stmooooore-lang/queue-engine/settings/secrets/actions`, but **it is not being passed to the runner environment** because the workflow file (`.github/workflows/cloud-agent.yml`) does not reference it in its `env:` section. GitHub Actions secrets must be explicitly mapped to environment variables in the workflow YAML to be available at runtime.

### Root Cause
The workflow YAML at `.github/workflows/cloud-agent.yml` passes other secrets (NVIDIA_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, etc.) but does **not** include:
```yaml
HUGGINGFACE_TOKEN: ${{ secrets.HUGGINGFACE_TOKEN }}
```
in the `env:` block for the relevant job step.

### Files Prepared (Ready for Deployment)
All files have been adapted for HF Spaces Docker SDK and are ready in `render-service/`:

- **README.md** — Updated with HF Spaces Docker SDK frontmatter:
  ```yaml
  ---
  sdk: docker
  app_port: 7860
  ---
  ```

- **Dockerfile** — Adapted for HF Spaces conventions:
  - Runs as user 1000 (`RUN useradd -m -u 1000 user; USER user`)
  - Exposes port 7860 (`EXPOSE 7860`)
  - Includes health check (`HEALTHCHECK CMD curl -f http://localhost:7860/health`)
  - Uses `--chown=user` on COPY commands
  - LiteLLM pinned to 1.83.9

- **server.js** — Changed PORT from `process.env.PORT || 3000` to hardcoded `7860`

- **cloud-config.yaml** — Unchanged (LiteLLM proxy config with model routing)

- **plexus_hooks.py** — Unchanged (LiteLLM proxy callback hooks)

- **package.json** + **package-lock.json** — Unchanged

### Required Fix
Add `HUGGINGFACE_TOKEN: ${{ secrets.HUGGINGFACE_TOKEN }}` to the `env:` section of the `run-agent` job (or a new dedicated deploy step) in `.github/workflows/cloud-agent.yml`, then re-run the workflow.

### Acceptance Criteria (Not Tested — Blocked by Missing Token)
- ❌ Space builds successfully
- ❌ GET / returns "ok"
- ❌ GET /test returns JSON with "answer" field containing "привет" (or equivalent)
- ❌ Process stays alive without OOM kills (16 GB RAM on free Docker tier)

### Deploy Script Location
`render-service/deploy-to-hf.py` — run with `python3 deploy-to-hf.py` once token is available in the environment.