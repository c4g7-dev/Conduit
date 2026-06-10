#!/usr/bin/env bash
# Chrooted SFTP access to the shared Conduit store (/var/lib/conduit on GlusterFS).
# Creates an SFTP-only `conduit` user on each node, chrooted to the shared tree (which is
# the same replicated data on every node). Key-auth only. Run from the workstation.
#
#   CONDUIT_SFTP_PUBKEY="ssh-ed25519 AAAA… you@host" ./scripts/setup-sftp.sh
#
# If CONDUIT_SFTP_PUBKEY is unset, the conduit provisioner key is authorized so you can
# `sftp -i ~/.conduit/conduit_ed25519 conduit@<node>`.
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.conduit/conduit_ed25519}"
SSH_USER="${SSH_USER:-root}"
NODES=(10.27.27.126 10.27.27.36 10.27.27.103)
ROOT=/var/lib/conduit
SFTP_USER=conduit

PUBKEY="${CONDUIT_SFTP_PUBKEY:-$(ssh-keygen -y -f "$SSH_KEY")}"
SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

for h in "${NODES[@]}"; do
  echo "==> $h"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$h" "bash -s" <<EOF
set -e
# SFTP-only user (no shell). Home is a writable subdir inside the chroot.
id $SFTP_USER >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin $SFTP_USER

# ChrootDirectory + all parents must be root-owned & not group/other-writable.
chown root:root $ROOT && chmod 755 $ROOT
# Writable working areas inside the chroot (owned by the sftp user).
mkdir -p $ROOT/overlays $ROOT/tasks $ROOT/assets $ROOT/services
chown $SFTP_USER:$SFTP_USER $ROOT/overlays $ROOT/tasks $ROOT/assets $ROOT/services

# Authorized key lives OUTSIDE the chroot (sshd reads it as root before chrooting).
install -d -m700 -o $SFTP_USER -g $SFTP_USER /etc/conduit/sftp/$SFTP_USER
printf '%s\n' "$PUBKEY" > /etc/conduit/sftp/$SFTP_USER/authorized_keys
chmod 600 /etc/conduit/sftp/$SFTP_USER/authorized_keys
chown $SFTP_USER:$SFTP_USER /etc/conduit/sftp/$SFTP_USER/authorized_keys

# sshd Match block (idempotent).
if ! grep -q 'Conduit SFTP' /etc/ssh/sshd_config; then
cat >> /etc/ssh/sshd_config <<SSHD

# --- Conduit SFTP (managed) ---
Match User $SFTP_USER
  AuthorizedKeysFile /etc/conduit/sftp/%u/authorized_keys
  ChrootDirectory $ROOT
  ForceCommand internal-sftp
  AllowTcpForwarding no
  X11Forwarding no
SSHD
fi
sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "    sftp ready: sftp -i <key> $SFTP_USER@$h  (chroot $ROOT)"
EOF
done
echo "Done. Connect:  sftp -i $SSH_KEY $SFTP_USER@${NODES[0]}"
