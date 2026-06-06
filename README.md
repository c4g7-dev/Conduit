# Conduit

**A Proxmox-native orchestrator for Minecraft networks — a self-hosted replacement for CloudNet.**

Conduit treats a Proxmox VE cluster as the substrate and adds the Minecraft-network
logic on top: server groups, tasks, blueprints, autoscaling primitives, Velocity
player-routing and live metrics. You describe the desired network; a controller
(`conduitd`) continuously reconciles Proxmox reality to match it.

> The original concept paper (German) is in [`KONZEPT.md`](./KONZEPT.md).

---

## Why two layers

| Layer | Responsibility |
|-------|----------------|
| **Proxmox VE** | Infrastructure: LXC isolation, storage, networking (DHCP/VLAN), live-migration, and **PBS backups**. |
| **Conduit** | MC logic: groups, tasks, blueprints, provisioning the actual Paper/Velocity software, routing, metrics. |

This split is the whole bet: we don't reimplement hosting (CloudNet's weakest area),
we inherit it from a battle-tested hypervisor and only own the Minecraft-shaped part.

---

## CloudNet factor-by-factor

This is the honest status against the factors that matter for the c4g7 network.

### 1. Multi-routing / load-balancing — ✅ working
- A **Velocity** proxy is provisioned as the player-facing edge (binds `:25565`).
- The controller discovers each backend's **DHCP IP via the Proxmox LXC API**,
  renders the proxy's `velocity.toml` `[servers]` block from those live IPs, and
  restarts the proxy **only when the backend set changes**.
- Velocity itself load-balances players across the servers in its `try` list and
  handles fail-over. Add more backend instances → they appear in the routing table
  automatically on the next reconcile.

### 2. Template system for scalable (non-static) servers — ✅ working
- **Blueprints** (`dashboard/src/lib/blueprints.ts`) are the templates: role + base
  image + resources + provisioning recipe. Shipped: `velocity-proxy`, `paper-lobby`
  (dynamic/stateless), `paper-smp` (static/persistent), `mariadb`.
- A **task** instantiates a blueprint N times. `dynamic` tasks (lobbies) are meant to
  scale on demand and be thrown away; `static` tasks (SMP/region) hold a fixed count
  with a persistent world. Scaling is one click (or one API call) today.
- ⏳ *Auto*-scaling on player count is not wired yet — the metrics needed for it
  (below) now exist, so the trigger is the remaining step.

### 3. Backups — ✅ working (PBS)
- Backups are **built-in via Proxmox + Proxmox Backup Server**: deduplicated,
  incremental, retained — no custom storage code. Persistent worlds live on their own
  LXC rootfs.
- Conduit drives it from the **Backups page**: attach a PBS datastore as storage, then
  **back up a whole group on demand** (vzdump over the pool) or **schedule per-group
  jobs** (systemd-calendar cron → `/cluster/backup`). Recent snapshots, sizes and
  per-storage usage are listed live. Verified: a running Paper world snapshotted to PBS
  in ~9s; a pool backup captured all three containers of the Time SMP group.

### 4. Management / dashboard — ✅ working
- Next.js + shadcn/ui dashboard: **Overview** (cluster + live player total),
  **Containers** (start/stop/reboot, IPs, tags), **Templates & Storage**,
  **Groups & Tasks** (create groups, deploy tasks from blueprints, scale live, see
  per-instance provisioning state, IPs, player counts, and proxy routing).
- Everything is also a **JSON API** (see below) so it's automatable, not UI-only.

### 5. Server groups & tasks (the CloudNet model) — ✅ working
- **Group** = a Proxmox **resource pool** + a slot limit + maintenance flag.
- **Task** = a blueprint + ruleset (mode, desired/min/max, fronts).
- The canonical example — **Time SMP** — is exactly: a group containing a *spawn/region*
  task (`paper-smp`, static, persistent), a *spawn/lobby* task (`paper-lobby`, dynamic,
  **autoscaling**) and an *edge* task (`velocity-proxy`) fronting both. Slot-limit and
  maintenance live on the group.

### Autoscaling — ✅ working
Dynamic tasks (lobbies) carry `autoscale: true`. Each reconcile the controller reads
live player counts (via SLP), computes a target — `ceil(players / playersPerInstance)
+ 1` to always keep one fresh joinable lobby — clamped to `[min, max]`, and
provisions/drains to match. **Scale-down only ever removes *empty* instances**, so it
never kicks a player. The live target is written back so the dashboard shows it.

---

## What it can and can't do today

**Can do**
- Create/delete groups (→ Proxmox pools) and tasks from the UI or API.
- Provision real LXC containers (VMID 200–999), boot them, read their DHCP IPs.
- **Install actual MC software in-container** (openjdk-17 + Paper 1.20.4 / Velocity
  3.3.0) over SSH+`pct exec`, write config + a `systemd` unit, and start it.
- Wire Velocity modern-forwarding (shared secret) so the proxy → backend hop is trusted.
- Scale a task up/down; the controller provisions/destroys to match.
- Read **live player counts + names** from every instance via Minecraft SLP — no plugin.
- Stay safe: it only ever touches containers tagged `conduit` in 200–999; hand-made
  containers (e.g. CT100) are never read as instances nor destroyed.

- Authenticate to the Proxmox API with a **revocable API token** (no password, no
  CSRF) — see `PROXMOX_TOKEN_ID`/`PROXMOX_TOKEN_SECRET`.

- Back up groups to **PBS** on demand and on a schedule, and list snapshots.

**Can't do yet**
- Seed worlds/plugins (servers come up vanilla Paper/Velocity).
- Restore-from-snapshot via the UI (backups + listing work; restore is still CLI).
- Multi-node placement strategy / live-migration from the UI (single node so far).
- SSH provisioning (`pct exec`) still uses the root password; should move to a
  dedicated SSH key. (The HTTP API already uses a scoped token.)

---

## Demo walkthrough (the Time SMP example)

```bash
# 1. a group  → becomes Proxmox pool "time-smp"
curl -X POST :3737/api/groups -d '{"name":"Time SMP","slotLimit":200}'

# 2. a persistent region/SMP task → controller provisions CT200, installs Paper, starts it
curl -X POST :3737/api/tasks \
  -d '{"name":"world","groupId":"time-smp","blueprintId":"paper-smp","desired":1}'

# 3. an edge proxy that fronts the SMP → CT201, installs Velocity, routes to CT200
curl -X POST :3737/api/tasks \
  -d '{"name":"edge","groupId":"time-smp","blueprintId":"velocity-proxy",
       "desired":1,"fronts":["time-smp-world"]}'
```

What the controller does on its 10s reconcile loop, with no further input:
1. picks a free VMID, clones the base LXC with `features: nesting=1`, tags it
   `conduit;g-time-smp;smp;t-time-smp-world`, starts it;
2. once it has a DHCP IP, installs the role's software in the background and stamps a
   `ready` tag;
3. renders the proxy's `velocity.toml` from the live backend IP and restarts Velocity.

Result: a player connecting to the **proxy IP on :25565** is forwarded to the Paper
backend. Verified live: secrets matched, both `systemd` services active, SLP reports
`Paper 1.20.4` / `Velocity`, network player total surfaced on the dashboard.

---

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/overview` | cluster nodes + totals |
| GET | `/api/containers` | all LXC with status, tags, IP |
| POST | `/api/containers/{vmid}/action` | start/stop/shutdown/reboot |
| GET | `/api/templates` | vztmpl images + storage |
| GET | `/api/blueprints` | premade templates |
| GET | `/api/conduit/state` | groups → tasks → instances (+ready) + routing |
| POST | `/api/conduit/reconcile` | force a reconcile pass |
| GET/POST | `/api/groups`, PATCH/DELETE `/api/groups/{id}` | group CRUD (maintenance, slotLimit) |
| POST | `/api/tasks`, PATCH/DELETE `/api/tasks/{id}` | task CRUD + live scaling |
| **GET** | **`/api/metrics`** | **live player counts + sample names per instance, via SLP** |
| GET/POST | `/api/backups` | storages + snapshots + jobs; trigger a vmid/pool backup |
| POST/DELETE | `/api/backups/jobs`, `/api/backups/jobs/{id}` | per-group scheduled backup jobs |

`/api/metrics` is the CloudNet-style telemetry feed — per-instance `online/max`,
player `sample` names, MOTD, version, latency, and a network total (counted at the edge).

---

## Architecture

```
dashboard/src/lib/
  proxmox.ts     # Proxmox VE API client (ticket auth, CSRF, LXC/pool CRUD, IPs)
  store.ts       # desired state (groups, tasks, network secret) in data/conduit.json
  blueprints.ts  # premade templates (role + base + resources + provision recipe)
  engine.ts      # conduitd: reconcile loop, discovery, provisioning, routing
  provision.ts   # in-container installs over SSH + pct exec (Paper/Velocity/systemd)
  mcping.ts      # Minecraft Server List Ping client (player counts, no plugin)
  instrumentation.ts  # starts the reconcile interval on server boot
```

**Reconcile pattern:** desired state (JSON) → engine diffs it against Proxmox reality
→ provisions or destroys to converge. Idempotent: a `ready` tag + an in-container
marker stop re-installs; the proxy config is only rewritten when backends change.

**Safety boundary:** VMID range 200–999 **and** the `conduit` tag are both required
before the engine will read or mutate a container.

---

## Running it

```bash
cd dashboard
cp .env.example .env.local   # fill in your Proxmox host + creds
npm install
npm run dev                  # or: npm run build && npm run start
```

Requirements: a Proxmox VE node with a Debian-12 LXC template, a bridge with DHCP,
and `sshpass` on the host running the dashboard (used for `pct exec` provisioning).
Set `CONDUIT_CONTROLLER=off` to run the dashboard without the reconcile loop.

> ⚠️ The dashboard holds Proxmox credentials server-side and SSHes to the node as root
> to provision containers. Run it on a trusted host on the management network. Replace
> the root password with a scoped PVE API token + SSH key before any real deployment.

---

## Roadmap

- World/plugin seeding (lobby world from git, region persistent dataset).
- Restore-from-snapshot from the Backups UI.
- Multi-node placement + live-migration controls.
- Dedicated SSH key for `pct exec` provisioning (API already uses a token).

Done recently: live SLP metrics · player-count autoscaling · PVE API-token auth ·
PBS backups (on-demand + per-group schedules).
