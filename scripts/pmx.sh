#!/usr/bin/env bash
# Tiny Proxmox API helper for the c4g7/Conduit dev box.
# Usage:  source scripts/pmx.sh        # auths, exports pmx() helper
#         pmx GET  /nodes
#         pmx POST /nodes/skdCore01/lxc -d vmid=120 -d ...
# Reads host/creds from env or defaults below.
PMX_HOST="${PMX_HOST:-10.27.27.126}"
PMX_USER="${PMX_USER:-root@pam}"
PMX_PASS="${PMX_PASS:?set PMX_PASS in your env — never hardcode credentials}"
PMX_BASE="https://${PMX_HOST}:8006/api2/json"

pmx_auth() {
  local resp
  resp=$(curl -sk -m 10 -d "username=${PMX_USER}&password=${PMX_PASS}" "${PMX_BASE}/access/ticket")
  PMX_TICKET=$(echo "$resp" | jq -r '.data.ticket')
  PMX_CSRF=$(echo "$resp" | jq -r '.data.CSRFPreventionToken')
  if [ -z "$PMX_TICKET" ] || [ "$PMX_TICKET" = "null" ]; then
    echo "AUTH FAILED: $resp" >&2; return 1
  fi
  export PMX_TICKET PMX_CSRF
  echo "auth ok (ticket cached)" >&2
}

pmx() {
  local method="$1"; shift
  local path="$1"; shift
  [ -z "${PMX_TICKET:-}" ] && pmx_auth
  curl -sk -m 30 -X "$method" \
    -b "PVEAuthCookie=${PMX_TICKET}" \
    -H "CSRFPreventionToken: ${PMX_CSRF}" \
    "${PMX_BASE}${path}" "$@"
}
export -f pmx pmx_auth 2>/dev/null || true
pmx_auth
