# Conduit Dashboard

The control panel for **Conduit** — the c4g7 MC-network orchestrator on Proxmox.
Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, talking to the Proxmox
VE API server-side.

## What works today

- **Overview** — live nodes, CPU/RAM usage, container counts (polls every 5s).
- **Containers** — list every LXC, start / stop / shutdown / reboot from the UI.
- **Templates & Storage** — base images for cloning + datastore usage.
- **Groups & Tasks** — the Conduit orchestration model (Time SMP: dynamic spawn
  task + static region task). UI is built; the `conduitd` controller behind it is
  the next milestone — see [`../KONZEPT.md`](../KONZEPT.md).

All Proxmox calls go through Next.js route handlers (`src/app/api/*`) so the
credentials in `.env.local` never reach the browser.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
# or
npm run build && npm run start -- -p 3737
```

Config lives in `.env.local`:

```
PROXMOX_HOST=10.27.27.126
PROXMOX_PORT=8006
PROXMOX_USER=root@pam
PROXMOX_PASS=...        # dev box only — use an API token + role before prod
PROXMOX_NODE=skdCore01
```

## Layout

```
src/
  lib/proxmox.ts            Proxmox API client (ticket auth + CSRF, node:https)
  lib/format.ts             bytes / pct / uptime helpers
  hooks/use-poll.ts         client polling hook
  app/api/overview          GET cluster + node summary
  app/api/containers        GET list · /[vmid]/action POST start|stop|shutdown|reboot
  app/api/templates         GET vztmpl + storage
  app/(pages)               overview · containers · templates · groups
  components/               sidebar-nav, page-header, status-badge, ui/* (shadcn)
```

## Next steps

- Create-container dialog (clone from template, pick pool/tags/resources).
- Per-container console + log stream (xterm.js over the vncwebsocket/term API).
- `conduitd`: reconcile loop driving the spawn-task autoscaler + Velocity bridge,
  feeding real player counts into the Groups page and wiring the maintenance toggle.
- Swap root password auth for a dedicated Proxmox API token with a least-privilege role.
