# HF Spaces Docker configuration
# - Runs as user 1000 (HF Spaces requirement)
# - Exposes port 7860 (HF Spaces requirement)
# - Health check on /health endpoint
# - LiteLLM pinned to 1.83.9 (newer versions fail to start)

FROM node:20-bookworm

# python3/pip installed explicitly rather than assumed present in the base
# image - the previous attempt guessed at what node:20-bookworm ships with
# and that guess is exactly the kind of mistake this project keeps paying for.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# LiteLLM pinned to 1.83.9 - the version after it fails to start at all
# (proxy_cli.py does a bare `from proxy_server import`, which only resolves
# when the proxy package directory is on sys.path; confirmed on GitHub's
# runner, run 32549839784). Debian 12/bookworm marks the system Python as
# externally-managed (PEP 668) - --break-system-packages is required or pip
# refuses outright.
RUN pip3 install --break-system-packages --no-cache-dir "litellm[proxy]==1.83.9"

# Install cline globally BEFORE switching to non-root user
RUN npm install -g cline

# Create user 1000 as required by HF Spaces - use 1001 since 1000 is taken
RUN useradd -m -u 1001 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

# Copy package files first for better caching
COPY --chown=user package.json package-lock.json ./
RUN npm install

# Copy application files
COPY --chown=user server.js cloud-config.yaml plexus_hooks.py ./

# HF Spaces requires port 7860
EXPOSE 7860

# Health check for HF Spaces
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:7860/health || exit 1

CMD ["node", "server.js"]
