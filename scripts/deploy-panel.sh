#!/usr/bin/env bash
# Deploys the Conduit web panel into a dedicated LXC on each Proxmox node, behind a
# keepalived VIP. Idempotent: re-run to upgrade the panel code in place.
#
# Usage:
#   CONDUIT_AGENT_TOKEN=<t> PROXMOX_TOKEN_ID=<id> PROXMOX_TOKEN_SECRET=<s> \
#     ./scripts/deploy-panel.sh
#
# Node → panel-LXC mapping (cluster-unique vmids) and VRRP priority:
#   node1 10.27.27.126  vmid 190  priority 150 (MASTER)
#   node2 10.27.27.36   vmid 191  priority 100
#   node3 10.27.27.103  vmid 192  priority 100
#
# VIP: first free IP probed from VIP_CANDIDATES (default 10.27.27.50).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$HERE/dashboard"
SSH_KEY="${SSH_KEY:-$HOME/.conduit/conduit_ed25519}"
SSH_USER="${SSH_USER:-root}"
TEMPLATE="${PANEL_TEMPLATE:-local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst}"
STORAGE="${PANEL_STORAGE:-local-lvm}"
BRIDGE="${PANEL_BRIDGE:-vmbr0}"
AGENT_PORT="${CONDUIT_AGENT_PORT:-8800}"
VIP_CANDIDATES=("${VIP:-10.27.27.50}" 10.27.27.51 10.27.27.60)

# host : vmid : priority
NODES=(
  "10.27.27.126:190:150"
  "10.27.27.36:191:100"
  "10.27.27.103:192:100"
)

: "${CONDUIT_AGENT_TOKEN:?must be set}"
: "${PROXMOX_TOKEN_ID:?must be set}"
: "${PROXMOX_TOKEN_SECRET:?must be set}"

SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
ssh_node() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$1" "${@:2}"; }
PUBKEY="$(ssh-keygen -y -f "$SSH_KEY")"

echo "==> building standalone panel bundle"
( cd "$DASH" && npm run build >/dev/null 2>&1 )
# Assemble the runnable tree: standalone + traced static + public.
BUNDLE="$(mktemp -d)"
cp -r "$DASH/.next/standalone/." "$BUNDLE/"
mkdir -p "$BUNDLE/.next"
cp -r "$DASH/.next/static" "$BUNDLE/.next/static"
[ -d "$DASH/public" ] && cp -r "$DASH/public" "$BUNDLE/public"
cp "$HERE/agent/console-proxy.mjs" "$BUNDLE/console-proxy.mjs"  # WS terminal bridge
# ws is bundled into Next's server chunks, so the standalone console-proxy.mjs can't
# resolve it — ship the (zero-dependency) ws package into the bundle's node_modules.
mkdir -p "$BUNDLE/node_modules"
cp -r "$DASH/node_modules/ws" "$BUNDLE/node_modules/ws"
rm -rf "$BUNDLE/data"  # never ship local dev state; panel uses agent state backend

# All node agent IPs (allowlist for the console proxy + state replication peers).
ALL_NODE_IPS="$(printf '%s\n' "${NODES[@]}" | cut -d: -f1 | paste -sd,)"
TARBALL="$(mktemp /tmp/conduit-panel.XXXXXX.tgz)"
tar -C "$BUNDLE" -czf "$TARBALL" .
echo "    bundle $(du -h "$TARBALL" | cut -f1)"

# Find a VIP already configured in an existing panel's keepalived.conf, so redeploys
# stay on the same address (the live VIP would otherwise look "used" and drift).
existing_vip() {
  for entry in "${NODES[@]}"; do
    IFS=: read -r host vmid _ <<< "$entry"
    ssh_node "$host" "true" 2>/dev/null || continue
    local vip
    vip=$(ssh_node "$host" "pct exec $vmid -- grep -oP '10\\.[0-9]+\\.[0-9]+\\.[0-9]+' /etc/keepalived/keepalived.conf 2>/dev/null | head -1" 2>/dev/null | tr -d '[:space:]')
    [ -n "$vip" ] && { echo "$vip"; return; }
  done
}

# VIP precedence: explicit $VIP env > already-configured VIP > first free candidate.
choose_vip() {
  if [ -n "${VIP:-}" ]; then echo "$VIP"; return; fi
  local existing; existing="$(existing_vip)"
  if [ -n "$existing" ]; then echo "$existing"; return; fi
  for ip in "${VIP_CANDIDATES[@]}"; do
    if ! ping -c1 -W1 "$ip" >/dev/null 2>&1; then echo "$ip"; return; fi
  done
  echo "ERROR: no free VIP among ${VIP_CANDIDATES[*]}" >&2; exit 1
}
VIP_ADDR="$(choose_vip)"
echo "==> VIP = $VIP_ADDR"

# Read the conduit SSH private key to inject into the panel (provision.ts needs it).
PRIV_KEY_B64="$(base64 -w0 "$SSH_KEY")"

deploy_one() {
  local host="$1" vmid="$2" prio="$3"
  echo "==> [$host] panel LXC $vmid (priority $prio)"

  # 1. Create the LXC if it doesn't exist.
  if ! ssh_node "$host" "pct status $vmid >/dev/null 2>&1"; then
    echo "    creating LXC $vmid"
    # Stage the pubkey to a temp file on the host (avoids fragile remote here-strings).
    printf '%s\n' "$PUBKEY" | ssh_node "$host" "cat > /tmp/conduit-panel-$vmid.pub"
    ssh_node "$host" "pct create $vmid $TEMPLATE \
      --hostname conduit-panel-$vmid \
      --cores 2 --memory 2048 --swap 512 \
      --rootfs $STORAGE:8 \
      --net0 name=eth0,bridge=$BRIDGE,ip=dhcp \
      --features nesting=1 --unprivileged 1 --onboot 1 \
      --tags conduit-panel \
      --ssh-public-keys /tmp/conduit-panel-$vmid.pub && rm -f /tmp/conduit-panel-$vmid.pub"
    ssh_node "$host" "pct start $vmid"
    # wait for DHCP lease
    for _ in $(seq 1 30); do
      ip=$(ssh_node "$host" "pct exec $vmid -- ip -4 addr show eth0 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1" || true)
      [ -n "${ip:-}" ] && break; sleep 2
    done
    echo "    LXC $vmid ip=${ip:-<none>}"
  else
    echo "    LXC $vmid exists — upgrading in place"
    ssh_node "$host" "pct start $vmid >/dev/null 2>&1 || true"
  fi

  # 2. Install Node.js in the LXC (binary tarball; Debian guest apt uses debian.org,
  #    so curl/xz-utils install fine — unlike the PVE hosts' enterprise repo).
  ssh_node "$host" "pct exec $vmid -- bash -c '
    set -e
    command -v node >/dev/null 2>&1 && exit 0
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl xz-utils ca-certificates >/dev/null
    cd /tmp
    curl -fsSL -o node.tar.xz https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz
    rm -rf /opt/node && mkdir -p /opt/node
    tar -xJf node.tar.xz -C /opt/node --strip-components=1
    ln -sf /opt/node/bin/node /usr/bin/node
    rm -f node.tar.xz
  '"

  # 3. Push the panel bundle.
  echo "    shipping bundle"
  ssh_node "$host" "pct exec $vmid -- bash -c 'rm -rf /opt/conduit-panel && mkdir -p /opt/conduit-panel'"
  # stream tarball → host → into the container
  cat "$TARBALL" | ssh_node "$host" "cat > /tmp/panel-$vmid.tgz && pct push $vmid /tmp/panel-$vmid.tgz /tmp/panel.tgz && pct exec $vmid -- tar -C /opt/conduit-panel -xzf /tmp/panel.tgz && rm -f /tmp/panel-$vmid.tgz && pct exec $vmid -- rm -f /tmp/panel.tgz"

  # 4. Write env, SSH key, systemd unit.
  ssh_node "$host" "pct exec $vmid -- bash -c '
    mkdir -p /etc/conduit /root/.conduit
    echo $PRIV_KEY_B64 | base64 -d > /root/.conduit/conduit_ed25519
    chmod 600 /root/.conduit/conduit_ed25519
    cat > /etc/conduit/panel.env <<EOF
NODE_ENV=production
PORT=3001
HOSTNAME=0.0.0.0
PROXMOX_HOST=$host
PROXMOX_TOKEN_ID=$PROXMOX_TOKEN_ID
PROXMOX_TOKEN_SECRET=$PROXMOX_TOKEN_SECRET
PROXMOX_SSH_KEY=/root/.conduit/conduit_ed25519
CONDUIT_ASSETS_DIR=/var/lib/conduit/assets
CONDUIT_AGENT_TOKEN=$CONDUIT_AGENT_TOKEN
CONDUIT_AGENT_PORT=$AGENT_PORT
CONDUIT_STATE_BACKEND=agent
CONDUIT_STATE_AGENT=$host
CONDUIT_VIP=$VIP_ADDR
CONDUIT_CONSOLE_PORT=8801
CONDUIT_NODES=$ALL_NODE_IPS
EOF
    chmod 600 /etc/conduit/panel.env
  '"
  cat "$HERE/agent/conduit-panel.service" | ssh_node "$host" "pct exec $vmid -- bash -c 'cat > /etc/systemd/system/conduit-panel.service'"
  cat "$HERE/agent/conduit-console.service" | ssh_node "$host" "pct exec $vmid -- bash -c 'cat > /etc/systemd/system/conduit-console.service'"

  # 5. keepalived (VRRP) — VIP floats to the live MASTER.
  ssh_node "$host" "pct exec $vmid -- bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    command -v keepalived >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq keepalived >/dev/null)
    STATE=BACKUP; [ $prio -ge 150 ] && STATE=MASTER
    cat > /etc/keepalived/keepalived.conf <<EOF
vrrp_instance conduit {
  state \$STATE
  interface eth0
  virtual_router_id 51
  priority $prio
  advert_int 1
  authentication { auth_type PASS; auth_pass conduit }
  virtual_ipaddress { $VIP_ADDR/24 }
}
EOF
    systemctl enable keepalived >/dev/null 2>&1 || true
    systemctl restart keepalived
  '"

  # 6. Start the panel + console proxy.
  ssh_node "$host" "pct exec $vmid -- bash -c 'systemctl daemon-reload; systemctl enable conduit-panel conduit-console >/dev/null 2>&1 || true; systemctl restart conduit-panel conduit-console'"
  echo "    [$host] panel $vmid up"
}

for entry in "${NODES[@]}"; do
  IFS=: read -r host vmid prio <<< "$entry"
  # Skip nodes we can't reach (e.g. node3 before it's onboarded).
  if ssh_node "$host" "true" 2>/dev/null; then
    deploy_one "$host" "$vmid" "$prio"
  else
    echo "==> [$host] unreachable over SSH — skipping (onboard it first)"
  fi
done

rm -rf "$BUNDLE" "$TARBALL"
echo "All reachable nodes deployed. VIP = $VIP_ADDR → http://$VIP_ADDR:3001"
