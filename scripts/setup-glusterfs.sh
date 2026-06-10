#!/usr/bin/env bash
# GlusterFS replica-3 shared store for Conduit across the 3 nodes.
#
# Two staged steps (run from the workstation; SSHes to each node as root):
#   ./setup-glusterfs.sh prepare   # non-destructive: install, peer, volume, copy data IN
#   ./setup-glusterfs.sh cutover   # destructive: stop CT205, switch /var/lib/conduit → gluster
#
# Brick: /data/conduit-brick on each node's root FS. Volume `conduit` replica 3, fuse-mounted
# at /var/lib/conduit on every node (so it replaces today's per-node local dir).
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.conduit/conduit_ed25519}"
SSH_USER="${SSH_USER:-root}"
NODES=(10.27.27.126 10.27.27.36 10.27.27.103)   # [0] = primary/control
PRIMARY="${NODES[0]}"
BRICK=/data/conduit-brick
VOL=conduit
MOUNT=/var/lib/conduit
HYTALE_VMID=205            # holds the /var/lib/conduit/assets bind mount (on node2)

SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
nssh() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$1" "${@:2}"; }

prepare() {
  echo "==> [1/4] installing glusterfs-server on all nodes"
  for h in "${NODES[@]}"; do
    nssh "$h" "set -e
      if ! command -v glusterd >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null 2>&1 || true
        apt-get install -y -qq glusterfs-server >/dev/null
      fi
      systemctl enable --now glusterd >/dev/null 2>&1
      mkdir -p $BRICK
      glusterd --version | head -1"
    echo "    $h ok"
  done

  echo "==> [2/4] peering nodes from $PRIMARY"
  for h in "${NODES[@]:1}"; do nssh "$PRIMARY" "gluster peer probe $h" || true; done
  sleep 3
  nssh "$PRIMARY" "gluster peer status | grep -E 'Number|Hostname|State' || true"

  echo "==> [3/4] creating + starting replica-3 volume '$VOL'"
  local bricks=""
  for h in "${NODES[@]}"; do bricks="$bricks $h:$BRICK"; done
  if ! nssh "$PRIMARY" "gluster volume info $VOL >/dev/null 2>&1"; then
    nssh "$PRIMARY" "gluster volume create $VOL replica 3 transport tcp$bricks force"
    nssh "$PRIMARY" "gluster volume start $VOL"
  else
    echo "    volume exists"
  fi
  nssh "$PRIMARY" "gluster volume status $VOL | head -20 || true"

  echo "==> [4/4] copying existing /var/lib/conduit data INTO the volume (non-destructive)"
  for h in "${NODES[@]}"; do
    nssh "$h" "set -e
      mkdir -p /mnt/conduit-stage
      mountpoint -q /mnt/conduit-stage || mount -t glusterfs localhost:/$VOL /mnt/conduit-stage
      if [ -d $MOUNT ] && [ ! -L $MOUNT ]; then
        # merge this node's local data into the shared volume (no overwrite of newer)
        rsync -a --ignore-existing $MOUNT/ /mnt/conduit-stage/ 2>/dev/null || cp -an $MOUNT/. /mnt/conduit-stage/ 2>/dev/null || true
      fi
      du -sh /mnt/conduit-stage 2>/dev/null | awk '{print \"    shared volume now: \"\$1}'
      umount /mnt/conduit-stage 2>/dev/null || true"
    echo "    $h staged"
  done
  echo "==> prepare done. Review, then run: $0 cutover"
}

cutover() {
  echo "==> stopping Hytale CT$HYTALE_VMID (releases the /var/lib/conduit/assets bind mount)"
  for h in "${NODES[@]}"; do
    nssh "$h" "pct status $HYTALE_VMID >/dev/null 2>&1 && pct stop $HYTALE_VMID && echo '    stopped on $h' || true"
  done

  echo "==> switching $MOUNT → gluster on every node"
  for h in "${NODES[@]}"; do
    nssh "$h" "set -e
      umount /mnt/conduit-stage 2>/dev/null || true
      if [ -d $MOUNT ] && [ ! -L $MOUNT ] && ! mountpoint -q $MOUNT; then
        mv $MOUNT ${MOUNT}.local.bak
      fi
      mkdir -p $MOUNT
      grep -q '$MOUNT glusterfs' /etc/fstab || echo 'localhost:/$VOL $MOUNT glusterfs defaults,_netdev,x-systemd.automount 0 0' >> /etc/fstab
      mountpoint -q $MOUNT || mount -t glusterfs localhost:/$VOL $MOUNT
      mountpoint -q $MOUNT && echo '    mounted on $h'"
  done

  echo "==> restarting Hytale CT$HYTALE_VMID"
  for h in "${NODES[@]}"; do
    nssh "$h" "[ -f /etc/pve/nodes/\$(hostname)/lxc/$HYTALE_VMID.conf ] && pct start $HYTALE_VMID && echo '    started on $h' || true" 2>/dev/null || true
  done

  echo "==> verify replication"
  nssh "$PRIMARY" "echo conduit-gluster-\$(date +%s) > $MOUNT/.replication-test"
  sleep 2
  for h in "${NODES[@]}"; do
    nssh "$h" "cat $MOUNT/.replication-test 2>/dev/null | sed 's/^/    '$h': /'"
  done
  nssh "$PRIMARY" "rm -f $MOUNT/.replication-test"
  echo "==> cutover done."
}

case "${1:-}" in
  prepare) prepare ;;
  cutover) cutover ;;
  *) echo "usage: $0 prepare|cutover" >&2; exit 1 ;;
esac
