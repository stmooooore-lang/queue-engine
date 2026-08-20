# Worker Deployment & Secrets

## Required Secrets (set via `wrangler secret put`)

| Secret Name | Description | Command |
|-------------|-------------|---------|
| `TURSO_DATABASE_URL` | Database connection URL | `npx wrangler secret put TURSO_DATABASE_URL` |
| `TURSO_AUTH_TOKEN` | Database auth token | `npx wrangler secret put TURSO_AUTH_TOKEN` |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | `npx wrangler secret put TELEGRAM_BOT_TOKEN` |
| `TELEGRAM_ALLOWED_USER_ID` | Your Telegram user ID (numeric) | `npx wrangler secret put TELEGRAM_ALLOWED_USER_ID` |
| `GITHUB_TOKEN` | GitHub PAT with `workflow` scope | `npx wrangler secret put GITHUB_TOKEN` |

## Deploy Worker

```bash
cd worker
npx wrangler deploy
```

## Set Webhook

After deploy, set the Telegram webhook to the Worker URL:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://plexus-queue-worker.<your-subdomain>.workers.dev"}'
```

## GitHub Actions Secrets

In repository Settings > Secrets and variables > Actions:

| Secret Name | Description |
|-------------|-------------|
| `TURSO_DATABASE_URL` | Same as worker |
| `TURSO_AUTH_TOKEN` | Same as worker |
| `TELEGRAM_BOT_TOKEN` | Same as worker |
| `TELEGRAM_CHAT_ID` | Your numeric chat/user ID |