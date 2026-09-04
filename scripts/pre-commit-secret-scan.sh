#!/usr/bin/env bash
# pre-commit-secret-scan.sh — catches LiteLLM master keys and GCP
# service-account JSON blobs in staged content before they're committed.
#
# Patterns based on the real secrets this repo actually handles (see
# .github/workflows/cloud-agent.yml): LITELLM_MASTER_KEY (openssl rand
# -hex 32 output, sometimes prefixed sk-), GCP_SA_KEY/
# VERTEX_CREDENTIALS_JSON (a full service-account JSON key file).
#
# Install: ln -sf ../../scripts/pre-commit-secret-scan.sh .git/hooks/pre-commit
# (run from the repo root) — a symlink, not a copy, so future edits to
# this script apply without reinstalling the hook.
set -euo pipefail

files=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$files" ] && exit 0

found=0

while IFS= read -r f; do
    [ -f "$f" ] || continue
    content=$(git show ":$f" 2>/dev/null) || continue

    # GCP service-account JSON key: the combination of these two markers
    # together is specific enough to avoid false positives on ordinary
    # JSON/docs mentioning one or the other in isolation.
    if printf '%s' "$content" | grep -q '"type"[[:space:]]*:[[:space:]]*"service_account"' \
       && printf '%s' "$content" | grep -q 'BEGIN PRIVATE KEY'; then
        echo "SECRET-SCAN: $f looks like a GCP service-account JSON key (service_account + private key block)" >&2
        found=1
    fi

    # LiteLLM master key: 'sk-' + 20+ alnum, or a bare 64-char hex string
    # (the openssl rand -hex 32 shape) assigned near a *MASTER_KEY*-named
    # variable.
    if printf '%s' "$content" | grep -qE 'sk-[A-Za-z0-9_-]{20,}'; then
        echo "SECRET-SCAN: $f contains an sk-... style key (LiteLLM master key shape)" >&2
        found=1
    fi
    if printf '%s' "$content" | grep -qiE '(MASTER_KEY|LITELLM_MASTER_KEY)[[:space:]]*[:=][[:space:]]*["'"'"']?[a-f0-9]{64}["'"'"']?'; then
        echo "SECRET-SCAN: $f assigns a 64-char hex value to a *MASTER_KEY* name (LiteLLM master key shape)" >&2
        found=1
    fi
done <<< "$files"

if [ "$found" = "1" ]; then
    echo "SECRET-SCAN: commit blocked. Remove the secret (use \${{ secrets.* }} / an env var reference instead of a literal value) and try again." >&2
    echo "SECRET-SCAN: to bypass deliberately (never for a real secret): git commit --no-verify" >&2
    exit 1
fi

exit 0
