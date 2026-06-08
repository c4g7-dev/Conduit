#!/usr/bin/env bash
# Populate the shared store from the current cluster state:
#   - overlays/<eggId>/   seeded (once) from a running service's perf-safe config/plugins
#   - tasks/<taskId>/     created (empty, ready to edit)
# Safe + idempotent: only reads from containers and writes to the shared store (no reboots,
# no container changes). The per-service /opt/shared bind-mount is applied separately by the
# engine (new services) or `--shares` (existing, staged with reboots).
set -euo pipefail

TOKEN="${CONDUIT_AGENT_TOKEN:?set CONDUIT_AGENT_TOKEN}"
PANEL="${CONDUIT_PANEL:-http://10.27.27.50:3001}"
NODES=(10.27.27.126 10.27.27.36 10.27.27.103)
AGENT_PORT="${CONDUIT_AGENT_PORT:-8800}"

# Any node's agent can write the store (gluster is shared); use node1.
agent() { curl -s --max-time 60 -H "Authorization: Bearer $TOKEN" -X POST "http://${NODES[0]}:$AGENT_PORT/v1/exec" -d "$1"; }
# Run a command on the node that hosts a given vmid.
node_of() { # $1=vmid -> prints host
  for h in "${NODES[@]}"; do
    if curl -s --max-time 6 -H "Authorization: Bearer $TOKEN" -X POST "http://$h:$AGENT_PORT/v1/exec" -d "{\"cmd\":\"pct status $1 >/dev/null 2>&1 && echo yes\"}" | grep -q yes; then echo "$h"; return; fi
  done
}

echo "==> reading cluster state"
STATE=$(curl -s --max-time 10 "$PANEL/api/conduit/state")

python3 - "$STATE" <<'PY' > /tmp/_mig.tsv
import json, sys
st = json.loads(sys.argv[1])
for g in st.get("groups", []):
    for t in g.get("tasks", []):
        vmid = next((i["vmid"] for i in t.get("instances", []) if i.get("status") == "running"), "")
        print(f'{t["id"]}\t{t["blueprintId"]}\t{t.get("softwareKind","generic")}\t{vmid}')
PY

while IFS=$'\t' read -r taskId egg kind vmid; do
  echo "==> task=$taskId egg=$egg kind=$kind vmid=${vmid:-none}"
  # structural dirs (always)
  agent "{\"cmd\":\"mkdir -p /var/lib/conduit/overlays/$egg /var/lib/conduit/tasks/$taskId\"}" >/dev/null
  # seed overlay from a running instance's config (only if overlay is empty)
  if [ -n "$vmid" ]; then
    host=$(node_of "$vmid")
    [ -z "$host" ] && continue
    case "$kind" in
      paper) paths="plugins server.properties bukkit.yml spigot.yml config" ; sd=/opt/mc ;;
      velocity) paths="velocity.toml plugins" ; sd=/opt/mc ;;
      nginx) paths="." ; sd=/opt/www ;;
      *) paths="" ;;
    esac
    if [ -n "$paths" ]; then
      curl -s --max-time 90 -H "Authorization: Bearer $TOKEN" -X POST "http://$host:$AGENT_PORT/v1/exec" -d "{\"cmd\":\"O=/var/lib/conduit/overlays/$egg; if [ -z \\\"\$(ls -A \$O 2>/dev/null)\\\" ]; then for p in $paths; do pct exec $vmid -- test -e $sd/\$p 2>/dev/null && (pct exec $vmid -- tar c -C $sd \$p 2>/dev/null | tar x -C \$O 2>/dev/null) || true; done; echo seeded; else echo skip-nonempty; fi\",\"timeoutMs\":85000}" | python3 -c "import json,sys;print('   overlay:',json.load(sys.stdin).get('stdout','').strip())" 2>&1
    fi
  fi
done < /tmp/_mig.tsv
rm -f /tmp/_mig.tsv
echo "==> migrate-store done. overlays + tasks populated on the shared store."
