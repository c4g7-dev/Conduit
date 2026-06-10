#!/usr/bin/env bash
# Deploys the Conduit Node Agent to one or more Proxmox hosts over SSH.
#
# Usage:
#   CONDUIT_AGENT_TOKEN=<token> ./scripts/deploy-agent.sh <host> [<host> ...]
#
# Env:
#   CONDUIT_AGENT_TOKEN   shared secret (required; must match dashboard .env.local)
#   SSH_KEY               ssh private key (default ~/.conduit/conduit_ed25519)
#   SSH_USER              ssh user (default root)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_SRC="$HERE/agent"
SSH_KEY="${SSH_KEY:-$HOME/.conduit/conduit_ed25519}"
SSH_USER="${SSH_USER:-root}"

if [ -z "${CONDUIT_AGENT_TOKEN:-}" ]; then
  echo "ERROR: CONDUIT_AGENT_TOKEN must be set" >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "Usage: CONDUIT_AGENT_TOKEN=<t> $0 <host> [<host> ...]" >&2
  exit 1
fi

SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

for HOST in "$@"; do
  echo "==> deploying to $HOST"
  # Ship the agent tree + installer as a tarball, extract into /opt/conduit-agent.
  tar -C "$AGENT_SRC" -czf - package.json src conduit-agent.service \
    | ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" \
        "mkdir -p /opt/conduit-agent && tar -C /opt/conduit-agent -xzf -"
  # Copy the installer and run it with the token.
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" \
    "CONDUIT_AGENT_TOKEN='$CONDUIT_AGENT_TOKEN' bash -s" < "$HERE/scripts/install-agent.sh"
  echo "==> $HOST done"
done

echo "All hosts deployed."
