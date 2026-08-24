#!/bin/bash
# plexus-doc push guard - mirrors the logic from cloud-agent.yml
# Prevents direct pushes to main for release surfaces: site/, worker/, wrangler.jsonc
# Usage: ./plexus-doc-push-guard.sh [git push args...]

set -euo pipefail

REPO_DIR="/home/runner/plexus-doc"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: $REPO_DIR is not a git repository" >&2
  exit 1
fi

cd "$REPO_DIR"

# Check if there are any staged/unstaged changes
if [ -n "$(git status --porcelain)" ]; then
  git config user.name "plexus-vm-agent"
  git config user.email "noreply@plexus-queue-vm"
  git add -A
  git diff --cached --quiet || git commit -q -m "vm-agent: auto-commit from poller task"
fi

# Check what would be pushed to origin/main
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)

if [ "$ahead" = "0" ]; then
  echo "nothing to push in plexus-doc"
  exit 0
fi

# Check if any changed files touch release surfaces
if git diff origin/main..HEAD --name-only | grep -qE '^(site/|worker/|wrangler\.jsonc$)'; then
  # Generate branch name with timestamp
  branch="vm-agent/review-$(date -u +%Y%m%d-%H%M%S)"
  git push origin "HEAD:$branch"
  echo "::warning::plexus-doc changes touch site/worker/wrangler.jsonc (a release surface) - pushed to $branch instead of main. Founder must review and merge by hand."
else
  git push origin HEAD:main
  echo "pushed $ahead commit(s) to plexus-doc main"
fi