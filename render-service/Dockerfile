# Render's own docs recommend Docker whenever a service needs two language
# runtimes at once (render.com/docs/native-runtimes): this needs pip for
# LiteLLM and npm for Cline, and a native Render runtime only ever gives you
# one.
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

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install && npm i -g cline

COPY server.js ./
COPY cloud-config.yaml plexus_hooks.py /

EXPOSE 10000
CMD ["node", "server.js"]
