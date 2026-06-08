#!/usr/bin/env bash
# Installs the Conduit Node Agent on a Proxmox host.
#
# Usage (run ON the PVE host, or pipe via ssh):
#   CONDUIT_AGENT_TOKEN=<token> bash install-agent.sh
#
# Idempotent: safe to re-run to upgrade the agent code.
set -euo pipefail

AGENT_DIR=/opt/conduit-agent
ENV_DIR=/etc/conduit
ENV_FILE="$ENV_DIR/agent.env"
PORT="${CONDUIT_AGENT_PORT:-8800}"
TMUX_SOCKET="${CONDUIT_TMUX_SOCKET:-mc}"

if [ -z "${CONDUIT_AGENT_TOKEN:-}" ]; then
  echo "[install] ERROR: CONDUIT_AGENT_TOKEN must be set" >&2
  exit 1
fi

echo "[install] checking for Node.js…"
# Install from the official binary tarball (no apt — PVE enterprise repos are
# often unsubscribed/401 and would break apt-get update).
NODE_VERSION="${NODE_VERSION:-v20.18.1}"
NODE_PREFIX=/opt/node
if ! command -v node >/dev/null 2>&1 && [ ! -x "$NODE_PREFIX/bin/node" ]; then
  echo "[install] installing Node.js $NODE_VERSION from nodejs.org…"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64) NODE_ARCH=arm64 ;;
    *) echo "[install] unsupported arch: $ARCH" >&2; exit 1 ;;
  esac
  TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  cd /tmp
  curl -fsSL -o "$TARBALL" "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"
  rm -rf "$NODE_PREFIX"
  mkdir -p "$NODE_PREFIX"
  tar -xJf "$TARBALL" -C "$NODE_PREFIX" --strip-components=1
  rm -f "$TARBALL"
  ln -sf "$NODE_PREFIX/bin/node" /usr/bin/node
  ln -sf "$NODE_PREFIX/bin/npm" /usr/bin/npm
fi
# Make sure node is on PATH for the rest of this script.
export PATH="$NODE_PREFIX/bin:$PATH"
echo "[install] node $(node --version)"

echo "[install] writing agent code to $AGENT_DIR…"
mkdir -p "$AGENT_DIR/src"
# The caller streams package.json + index.mjs into these paths (see deploy step).
# If running standalone, expect the files to already be present in $AGENT_DIR.

echo "[install] installing npm deps…"
cd "$AGENT_DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1

echo "[install] writing $ENV_FILE…"
mkdir -p "$ENV_DIR"
cat > "$ENV_FILE" <<EOF
CONDUIT_AGENT_TOKEN=$CONDUIT_AGENT_TOKEN
CONDUIT_AGENT_PORT=$PORT
CONDUIT_TMUX_SOCKET=$TMUX_SOCKET
EOF
chmod 600 "$ENV_FILE"

echo "[install] installing systemd unit…"
cp "$AGENT_DIR/conduit-agent.service" /etc/systemd/system/conduit-agent.service
systemctl daemon-reload
systemctl enable conduit-agent >/dev/null 2>&1 || true
systemctl restart conduit-agent

sleep 1
if systemctl is-active --quiet conduit-agent; then
  echo "[install] conduit-agent is running on port $PORT"
else
  echo "[install] WARNING: conduit-agent failed to start — check: journalctl -u conduit-agent" >&2
  exit 1
fi
