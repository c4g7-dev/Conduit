# Conduit

**A Proxmox-native orchestrator for Minecraft (and Hytale) networks — a self-hosted, HA replacement for CloudNet.**

Conduit treats a **Proxmox VE cluster** as the substrate and adds the network logic on top:
server groups, tasks, blueprints, fast clone-based autoscaling, Velocity player-routing,
seamless world-sharding, live metrics, and per-player control. You describe the desired
network; a leader-elected controller (`conduitd`) continuously reconciles Proxmox reality to
match it.

> Concept paper (German): [`KONZEPT.md`](./KONZEPT.md).

---

## The bet

| Layer | Owns |
|-------|------|
| **Proxmox VE** | Infrastructure — LXC isolation, LVM-thin storage, DHCP/bridged networking, live-migration, **PBS backups**. |
| **Conduit** | Network logic — groups, tasks, blueprints, in-container software install, routing, autoscaling, metrics, sharding. |

We don't reimplement hosting (CloudNet's weakest area); we inherit it from a battle-tested
hypervisor and only own the Minecraft-shaped part.

---

## Architecture

```
                      ┌─────────────── keepalived VIP (10.27.27.50:3001) ───────────────┐
                      │                                                                  │
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐        players ──► ┌─────────────────┐
   │ panel CT 190 │   │ panel CT 191 │   │ panel CT 192 │                     │ Velocity proxy  │ :25565
   │ (node1)      │   │ (node2)      │   │ (node3)      │                     └────────┬────────┘
   │ Next.js +    │   │  (BACKUP)    │   │  (BACKUP)    │                              │ routes
   │ conduitd ◄───┼── leader-gated on the VIP ──────────┘                ┌────────────┼────────────┐
   └──────┬───────┘                                                      ▼            ▼            ▼
          │ Proxmox API (token) + per-node agent (:8800)            ┌─────────┐ ┌─────────┐ ┌─────────┐
          ▼                                                          │ Paper   │ │ Paper   │ │ Hytale  │
   ┌──────────────┬──────────────┬──────────────┐                    │ lobby   │ │ world   │ │ server  │
   │   node1      │   node2      │   node3      │                    └────┬────┘ └────┬────┘ └────┬────┘
   │ conduit-agent│ conduit-agent│ conduit-agent│                         │  Conduit connector plugin │
   │  LXC 200…    │  LXC 200…    │  LXC 200…    │                         └──── heartbeat / actions ──┘
   └──────────────┴──────────────┴──────────────┘                                    │ HTTP/1.1
        GlusterFS replica-3  /var/lib/conduit  ◄──── shared store ────► panel ◄───────┘
```

**Components**

- **Panel** — Next.js (standalone build) running in an LXC on **every node** (CT 190/191/192),
  fronted by a **keepalived VIP**. The `conduitd` reconcile loop is **leader-gated**: only the
  panel holding the VIP runs it, so there's exactly one controller, and it fails over with the VIP.
- **conduit-agent** — a small Node service on every Proxmox node (`:8800`): runs `pct exec`,
  sandboxed in-container file ops (`/v1/fs`), and a console WebSocket bridge. The panel uses the
  **Proxmox API** for orchestration and the agent for in-container work.
- **GlusterFS replica-3** at `/var/lib/conduit` on all nodes — the shared store for state, file
  overlays, uploaded assets, per-service config, and the built connector jars.
- **Connector plugins** — see below; the live data + control plane inside each game server.
- **Reconcile pattern** — desired state (JSON) → engine diffs it against live Proxmox reality →
  provisions/clones/destroys to converge. Idempotent (a `ready` tag + an in-container marker stop
  re-installs); the proxy config is only rewritten when the backend set changes.
- **Safety boundary** — the engine only ever reads or mutates containers in **VMID 200–999** that
  carry the **`conduit` tag**. Hand-made containers are invisible to it. Persistent instances are
  never auto-destroyed.

Key modules (`dashboard/src/lib/`): `proxmox.ts` (API client), `engine.ts` (conduitd: reconcile,
discovery, provisioning, autoscale, routing, redis, sharding), `provision.ts` (in-container
install recipes), `store.ts` (desired state, agent-replicated), `blueprints.ts` (eggs),
`connector.ts` (live registry), `sharding.ts` / `shard-state.ts`, `redis-cluster.ts`, `images.ts`
(golden-image clones), `metrics-history.ts`.

---

## The connector (CloudNet-Bridge equivalent)

Built without Gradle (plain `javac` + `jar`); jars live on the shared store and are pushed into
each server at provision.

- **Minecraft** (`plugin/`, Paper + Velocity in one jar) — registers the server, **heartbeats the
  full player list (name + UUID), counts and TPS** every ~3 s, reports join/quit/switch events, and
  **executes actions** the panel queues (move / message / kick). The Velocity side is also driven
  by a panel-supplied **config block**: fallback routing, MOTD, maintenance, tablist. In-game
  `/conduit` (aliases `/ct`, `/cloud`) with tab-completion. Uses the JDK HTTP client forced to
  **HTTP/1.1** (the Node panel mishandles HTTP/2).
- **Hytale** (`plugin-hytale/`, compiled against `HytaleServer.jar` with JDK 25) — same reporter
  role plus action execution via `referToServer` / `sendMessage` / `disconnect`. There's no Hytale
  proxy, so it drains its own actions.

Player data now comes **entirely from the connector** (full, exact lists) — the old SLP
(`mcping`) path is gone. Actions are **scoped to a player's current server** so a same-named MC
and Hytale player aren't both hit.

---

## What works today

**Orchestration**
- Groups (→ Proxmox pools, slot limit, maintenance) and tasks (blueprint + mode + min/max/desired
  + fronts) from the UI or JSON API.
- **Static** tasks hold a fixed count with persistent worlds; **dynamic** tasks autoscale on live
  player load (`ceil(players / playersPerInstance)` + headroom, clamped to `[min, max]`, with
  CloudNet-Smart knobs: scale-up %, idle-drain, spawn cooldown, prepared/warm pool, split-over-nodes).
- **Golden-image fast autoscaling** — build a per-egg LXC **template on each node**, then
  **linked-clone** it on demand (seconds vs. minutes) with an optional **warm pool** of pre-cloned
  stopped instances for instant scale-up. Multi-node: clones land on the node that holds the template.
- **Multi-node**: instances spread across nodes; move a service between nodes from the UI (Proxmox
  migration). Single controller via VIP leader election; panel + agents on every node.

**Software**
- Installs real software in-container over the agent/`pct exec`: **Paper / Velocity** (Java
  auto-installed from the Adoptium API for any major; version selectable per task from the PaperMC
  Fill API), **nginx**, **Redis**, **Hytale** (shared read-only `/assets` mount + downloader), and
  **custom generic templates** with a declarative recipe (apt packages → asset pulls → install
  script → supervised start command).
- Velocity modern-forwarding wired with a shared secret; routing table rendered from live backend
  IPs and applied with a hot `velocity reload` (no kicks) when the set changes.

**Seamless world-sharding** (TMregion-style, opt-in)
- One world split along the X axis into per-instance strips; players cross boundaries and are
  **handed off keeping their exact position** (same seed everywhere ⇒ continuous terrain). A blue
  particle wall + graduated action-bar warning mark the seam; the outer edge is a hard world border.
- **Redis player-data sync** carries inventory / HP / XP / effects across the handoff. The Redis
  egg is self-configuring: first instance = primary, extras auto-replicate with failover, and
  connectors discover the endpoints automatically.

**Observability & control**
- **Players** page: live (SSE) network player list with real skins, split MC / Hytale, right-click
  **move** (compatible-service picker), styled **message** composer (with `&`-code preview), and
  **kick** — all instant/optimistic.
- **Metrics**: Players / Containers / CPU / Memory over **5m / 1h / 24h / 30d**, from Proxmox RRD
  (cpu/mem) + a server-side sampler (players/containers), cluster-wide and per-instance.
- Per-service **live tmux console** + **file manager**, per-task **MOTD** editor, **persistent
  audit log**, **scheduled** restarts/broadcasts, an in-app **help center**, and a **mobile**
  drawer nav.

**Platform & safety**
- HA panel-per-node behind a keepalived VIP; corosync/agent-replicated state.
- PVE **API token** (revocable, no CSRF) + dedicated **SSH key** — no password on the wire.
- **PBS backups**: on-demand or per-group scheduled, list snapshots, one-click restore.

---

## API (selected)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/overview` | cluster nodes + totals |
| GET | `/api/conduit/state` | groups → tasks → instances (+ready) + routing |
| POST | `/api/conduit/reconcile` | force a reconcile pass |
| GET/POST/PATCH/DELETE | `/api/groups`, `/api/tasks` | group + task CRUD, live scaling |
| GET/POST/DELETE | `/api/containers`, `/api/containers/{vmid}` | list / action / **delete** |
| POST | `/api/containers/{vmid}/migrate` | move a service to another node |
| GET/POST | `/api/blueprints` | eggs incl. custom templates (+ recipe) |
| GET/POST | `/api/images`, `/api/images/build` | golden fast-clone images per egg/node |
| GET | `/api/metrics` · `/api/metrics/history?range=` | live counts · RRD time-series |
| GET | `/api/stream` | **SSE** live connector state (players/servers) |
| POST | `/api/connector/{register,heartbeat,event,action,transfer,pending}` | connector ingest + control |
| GET | `/api/connector/move-targets` | compatible servers a player can be moved to |
| POST/GET | `/api/tasks/{id}/sharding` | enable sharding (regen on a shared seed) / live grid |
| GET/POST | `/api/backups…` | PBS storages, snapshots, jobs, restore |
| GET/POST | `/api/services/{vmid}/{console,files}` | live console / file browser |

The full registry is in `dashboard/src/lib/api-registry.ts` (surfaced on the **API** page).

---

## Repo layout

```
dashboard/        Next.js panel + conduitd controller (the brain)
agent/            per-node conduit-agent (pct exec + fs + console WS) + systemd units
plugin/           Minecraft connector (Paper + Velocity), built with javac
plugin-hytale/    Hytale connector (compiled against HytaleServer.jar, JDK 25)
scripts/          deploy-panel.sh, deploy-agent.sh, setup-glusterfs.sh, setup-sftp.sh, …
examples/         walkthroughs (e.g. lobby autoscaling)
```

---

## Running it

**Single-node / dev:**

```bash
cd dashboard
cp .env.example .env.local      # Proxmox host + API token + SSH key
npm install
npm run dev                     # or: npm run build && npm run start
```

Requirements: a Proxmox VE node with a Debian-12 LXC template, a DHCP bridge, and a scoped **PVE
API token** + dedicated **SSH key** (`PROXMOX_TOKEN_ID/SECRET`, `PROXMOX_SSH_KEY`). Set
`CONDUIT_CONTROLLER=off` to run the UI without the reconcile loop.

**HA cluster deploy** (panel on every node behind a VIP, agents, shared store):

```bash
./scripts/setup-glusterfs.sh                                  # shared /var/lib/conduit
CONDUIT_AGENT_TOKEN=… ./scripts/deploy-agent.sh               # per-node agent on :8800
CONDUIT_AGENT_TOKEN=… PROXMOX_TOKEN_ID=… PROXMOX_TOKEN_SECRET=… \
  ./scripts/deploy-panel.sh                                   # panel CTs + keepalived VIP
```

> ⚠️ The panel talks to Proxmox server-side. Run it on the management network with a scoped API
> token + SSH key (no password on the wire).

---

## Status / not-done

- Velocity routing, autoscaling (incl. golden-image clones + warm pool), backups, sharding +
  Redis sync, Hytale, HA panel, multi-node moves, and live player control are all **working**.
- Custom-template recipes cover most generic servers; richer per-kind install recipes (full
  MariaDB schema, etc.) are still thin.
- Cross-node sharding handoff relies on a reachable Redis for state sync; position handoff works
  without it (per-region data only).
