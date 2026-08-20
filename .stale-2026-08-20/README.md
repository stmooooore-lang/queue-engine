# queue-engine

This is the engine repository. It contains the GitHub Actions workflow and scripts that execute unattended queue tasks and commit results to the `cursor-build` branch of `plexus-doc`.

See `AGENT-RULES.md` in the parent repo for operational rules.

## Secrets

All secrets live in GitHub Actions secrets (repo Settings → Secrets → Actions). **Never commit secrets to this repository.**

| Secret name | Description |
|-------------|-------------|
| `PAT_PLEXUS_DOC` | Personal Access Token with repo scope, for pushing to plexus-doc/cursor-build |
| `FLY_MACHINE_SECRET_1` | Optional: Fly.io Machine secrets |
| `LITELLM_KEY_1` | Optional: LiteLLM proxy key |

## Workflow

The workflow is in `.github/workflows/queue.yml`. It:

1. Runs on a daily schedule (unattended queue) or via `workflow_dispatch` (manual)
2. Executes corridor measurement or other assigned task
3. Commits results to the `cursor-build` branch of plexus-doc
4. Sends email notifications on start/failure/missed run

## Setup

1. Create a private GitHub repository named `queue-engine` under `stmooooore-lang`.
2. Push this code to it.
3. Set the secrets in GitHub Actions secrets.
4. Enable workflows.

## License

MIT