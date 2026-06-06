# Dev box notes (validated 2026-06-06)

Host: **10.27.27.126:8006** · Proxmox **9.2.3** · single node **skdCore01** (8 vCPU, 15 GB RAM)
Auth: `root@pam` / pw in `scripts/pmx.sh` (dev only — do NOT commit to a public remote).

## Facts
- Storage: `local-lvm` (lvmthin, ~59 GB, rootdir/images) · `local` (dir, ~33 GB, vztmpl/backup/iso)
- Network: one bridge `vmbr0` @ 10.27.27.126/24. LAN has DHCP (containers get 10.27.27.x).
- Template downloaded: `local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst`

## Validated API lifecycle (full CRUD works)
- Auth ticket: `POST /access/ticket`
- List: `GET /cluster/resources`, `GET /nodes/{n}/lxc`
- Create LXC: `POST /nodes/{n}/lxc` — **must url-encode `net0`** (`--data-urlencode`)
- Start/stop: `POST /nodes/{n}/lxc/{vmid}/status/{start|stop}`
- Status: `GET /nodes/{n}/lxc/{vmid}/status/current`
- IP: `GET /nodes/{n}/lxc/{vmid}/interfaces`
- Tasks: `GET /nodes/{n}/tasks/{upid}/status`

## Live objects
- **LXC 100 `conduit-test`** — running, ip 10.27.27.245. Demo object, safe to delete.
