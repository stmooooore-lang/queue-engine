#!/bin/bash
# setup-poller.sh - Install the poller as a systemd service on plexus-queue-vm
# Run as root (sudo) on the VM after copying the scripts/ directory there
# Prerequisite: poller:latest Docker image must already be loaded on the VM
# (transferred via docker save/load from GitHub Actions runner)

set -euo pipefail

SCRIPTS_DIR="/home/runner/scripts"
SERVICE_FILE="${SCRIPTS_DIR}/poller.service"
ENV_TEMPLATE="${SCRIPTS_DIR}/poller.env.template"
SECRETS_DIR="/run/secrets"
ENV_FILE="${SECRETS_DIR}/poller.env"

echo "=== Setting up Telegram Bot Task Queue Poller ==="

# Check running as root
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (sudo)" 
   exit 1
fi

# Check scripts directory exists
if [[ ! -d "${SCRIPTS_DIR}" ]]; then
    echo "Scripts directory ${SCRIPTS_DIR} not found. Copy the scripts/ directory first."
    exit 1
fi

# Check poller:latest image exists on VM (transferred from runner via docker save/load)
if ! docker image inspect poller:latest >/dev/null 2>&1; then
    echo "ERROR: poller:latest image not found on VM."
    echo "Build it on the GitHub Actions runner and transfer via:"
    echo "  docker save poller:latest | gzip > /tmp/poller.tar.gz"
    echo "  gcloud compute scp /tmp/poller.tar.gz plexus-queue-vm:/tmp/"
    echo "  gcloud compute ssh plexus-queue-vm -- 'gunzip -c /tmp/poller.tar.gz | docker load'"
    exit 1
fi

# Create secrets directory
mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

# Check if env file exists
if [[ ! -f "${ENV_FILE}" ]]; then
    echo ""
    echo "=== Secrets file not found: ${ENV_FILE} ==="
    echo "Please create it from the template:"
    echo "  cp ${ENV_TEMPLATE} ${ENV_FILE}"
    echo "  chmod 600 ${ENV_FILE}"
    echo "  # Then edit ${ENV_FILE} with actual secret values"
    echo ""
    echo "Required secrets (from GitHub Actions secrets):"
    echo "  TURSO_DATABASE_URL"
    echo "  TURSO_AUTH_TOKEN"
    echo "  TELEGRAM_BOT_TOKEN"
    echo "  LITELLM_MASTER_KEY"
    echo ""
    read -p "Press Enter after creating ${ENV_FILE} with actual values, or Ctrl+C to abort..."
fi

# Verify env file has values
source "${ENV_FILE}"
if [[ -z "${TURSO_DATABASE_URL}" || -z "${TURSO_AUTH_TOKEN}" || -z "${TELEGRAM_BOT_TOKEN}" ]]; then
    echo "ERROR: Required secrets not set in ${ENV_FILE}"
    exit 1
fi

# Install systemd service
echo "Installing systemd service..."
cp "${SERVICE_FILE}" /etc/systemd/system/poller.service
systemctl daemon-reload

# Enable and start
echo "Enabling poller service..."
systemctl enable poller.service

echo "Starting poller service..."
systemctl start poller.service

echo ""
echo "=== Poller service installed and started ==="
echo "Check status:  systemctl status poller"
echo "View logs:     journalctl -u poller -f"
echo "Restart:       systemctl restart poller"
echo "Stop:          systemctl stop poller"