# Conduit — Ideas & Roadmap Backlog

> Brain-dump of future features for Conduit (the Proxmox-native MC + Hytale network
> orchestrator). Rough priority tag on each:
> **[P1]** soon / high value · **[P2]** wanted · **[P3]** nice-to-have · **[deferred]** explicitly
> not now.

---

## ✅ Build status (updated 2026-06-11)

**Done & live on the cluster:**
- **§1 Version control** — pin/unpin, auto-hotfix within a line, explicit version switch, "update available" badges (MC; Hytale shows static).
- **§2 Templating** — egg + `_global/<kind>` + named templates + per-task overlay chain, prioritized; rewrite-on-change (templateSync) with optional restart; **instant sync on panel edits** (~0s) + 8s scan for SFTP.
- **§3 Groups/Subgroups/Queue** — nested subgroups, drag&drop, slot limits, join queue with VIP priority + panel view/kick.
- **§4 Maintenance** — WebUI toggle on group/subgroup/service, in-game `/conduit maintenance`, LuckPerms bypass tiers.
- **§5 LuckPerms** — Postgres+Redis backend, panel editor, **managed install set** (auto-installs on new instances).
- **§6 Limbo & routing** — NanoLimbo egg, proxy try-order editor, routing picker.
- **§8 Scheduling** — fine-grained targets (group/subgroup/service/instance), restart-on-empty, command + backup actions.
- **§11 Player audit** — session/action trail, history UI, retention, erasure.
- **Extra (not in original list):** system-service tagging + **rotatable Redis/Postgres credentials** (unlock-gated); **cross-service inventory sharing** via Redis (beyond one sharded world); HA panel, agents, sharding, golden-image autoscaling, metrics, SSE live status, file manager.

**Partial:**
- **§7 Hytale** — connector reports/executes already; **quic-relay proxy + auth flow not built**.
- **§10 Node placement** — pin-to-node works; **whitelist/blacklist modes not built**.
- **§16 UI polish** — live status / no-refresh, expanded settings, file-manager activity bar done; **custom service icons not built**.

**Not started:** §9 Firewall (dynamic forwarding + ASN), §12 Resource-pack hosting, §13 Language system, §14 Skript connector + Ashlyn rounds, §15 DB viewer.

**In-flight:** unify the target-picker model across the whole dashboard (persist selections as targets so a group pick auto-includes future members; try-order picker scoped to routed servers).

**Deferred:** seamless restart/updates, TimeSMP combat-log bypass, categories.

---

## 1. Version Control & Updating (Minecraft + Hytale)

Track and manage the **software version** of every instance — for **both Minecraft** (Paper,
Velocity, …) **and Hytale** (release / alpha lines / whatever build channels exist there).

- **[P1] Version awareness per egg/instance** — show the current version and what's available
  upstream (release lines, alpha/beta lines, etc.).
- **[P1] Auto-hotfix within the current line** — when auto-update is **ON**, an instance
  auto-updates to **hotfixes/patches inside its current version line** (stays on a known-good
  train, just rolls forward on safe fixes). It also generally keeps everything current within
  that line.
- **[P1] New full versions are surfaced, not forced** — a genuinely new major/full version is
  shown as **"update available"** but is **never auto-applied**. When auto-update is **OFF**,
  nothing updates automatically — you only see the available-update badge.
- **[P1] Pinning** — pin an instance to an exact version when stability matters.
- **[P2] Breaking-change flagging** — clearly mark updates that are breaking and require explicit
  confirmation before they can be applied.

---

## 2. Templating & Inheritance

- **[P1] Global templates** — templates that apply to a whole class of services, e.g. **all
  Minecraft servers** get a shared base layer of plugins/config.
- **[P1] Rewrite-on-restart for static services** — let a **static (persistent)** service be
  configured to **re-pull a specific template on every restart and rewrite all files inside that
  template's scope**, while preserving its persistent data (world, DB). Makes **core-plugin
  updates trivial**: bump the template, restart, every static server re-syncs the managed files.
- **[P2] Parenting / multiple templates per service** — a service (dynamic **or** static) can
  have **multiple templates layered** on it (parent → child), each contributing files, so you
  compose a service from reusable template pieces instead of one monolith.
- **[P2] Prioritization** — defined order for which template/config layer wins when several apply
  (global → group → subgroup → service).

---

## 3. Groups, Subgroups & Queue

Two-tier, **addressable** hierarchy: a main group (e.g. `network`) holds **subgroups
(Untergruppen)** of services (e.g. `timesmp`, `lobby`, `vip-lobby`), so ops can target one
subgroup without touching the rest.

```
Group (network)  ──►  Subgroup (Untergruppe)  ──►  Instances
                        timesmp                      timesmp-1, timesmp-2 …
                        lobby                         lobby-1 …
                        vip-lobby                     viplobby-1 …
```

- **[P1] Subgroups within the services/groups UI** — separate services into subgroups under a
  group, manageable in **UI + API**. Each group expands into subgroup cards showing live
  `players / capacity · server-count` and state (*active / starting / full / maintenance*) — the
  same at-a-glance roster as the old SUSI *Gruppenstatus* screen.
- **[P1] Built-in queue, managed in the panel** — a queue layer in Conduit (driven through the
  proxy) for when a subgroup is full/starting: players wait with position/ETA instead of
  bouncing. **Manageable from the panel** (view/clear/reorder, priority). Uses LuckPerms-based
  VIP priority (§5).

---

## 4. Maintenance System (WebUI + perms)

From the **old SUSI system** (Image: SUSI *Gruppenstatus*, `/susigroups maintenance TIMESMP
false`, perms `susi.maintenance.{admin,galaxy,sky,team,universe,vip}`). Bring it into Conduit but
**fully WebUI-manageable**.

- **[P1] Maintenance toggle on any target in the WebUI** — group, **subgroup**, or individual
  service/CT. Same op on the API and as a command. State reflects **instantly** (panel + proxy).
- **[P1] Per-permission bypass** — who can still join a target in maintenance is decided by
  permission (LuckPerms), e.g. `conduit.maintenance.<tier>`
  (`admin` > `team` > `universe`/`galaxy`/`sky` > `vip`). **Hard dependency on §5.**
- **[P2] Maintenance routing** — on enable, decide what happens to online players (kick to lobby /
  hold / leave) and to new joins (deny w/ custom message, or queue).

---

## 5. LuckPerms Integration  *(foundation — do early)*

> Prerequisite for the maintenance bypass tiers (§4) and queue VIP priority (§3) — those resolve
> "who's allowed" straight from permission data, so this must land first.

- **[P1] LuckPerms API ↔ Conduit connection** — register/connect Conduit to LuckPerms (its API /
  REST extension or shared storage DB) to read groups/tracks/nodes. Configure + health-check the
  link from the panel (connected/disconnected status).
- **[P1] Built-in LuckPerms editor in the panel** — a permissions UI **inside Conduit** that
  looks like the panel theme but **mirrors the LuckPerms web editor**: same features (browse/edit
  users, groups, tracks, nodes, inheritance, weights) — our own, themed, native to the dashboard.
- **[P2] Conduit-specific nodes** — read + grant/revoke the Conduit nodes (maintenance bypass,
  queue priority, command access) from that editor.

---

## 6. Limbo & Proxy Routing

- **[P1] UI-managed Limbo** — a lightweight limbo/fallback server (NanoLimbo-style) players land
  on when **no lobby is available or all are full**, instead of being disconnected. Deployable +
  managed as a normal Conduit service from the WebUI; assign it as the network fallback.
  *(TJC reference — clean that integration up.)*
- **[P1] Proxy "try" / allowed-servers list in the UI** — the panel can set routing today; extend
  it so you also edit **which servers are allowed in the proxy's `try` attribute** (the fallback
  list + order), not just routing. Same UX as the existing MC proxy settings.

---

## 7. Hytale Networking

- **[P1] Hytale proxy via quic-relay** — adopt a QUIC relay
  (ref: `github.com/HyBuildNet/quic-relay`) as the **Velocity-equivalent proxy for Hytale**.
  Hytale services join the **same group/network model** as MC, sit behind a Hytale proxy, and are
  configured from the panel **with the same UI as the MC proxy** ("network-like" — one mental
  model both platforms).
- **[P2] Hytale Auth / Login flow** — build Hytale auth where, from an **already authenticated
  panel session**, you can see login **status for all Hytale servers** and log them in from one
  place; if a server isn't logged in, surface that. **Use the connector** for this where possible.

---

## 8. Scheduling & Lifecycle

- **[P1] Fine-grained schedules** — today schedules hit ALL servers in a group. Expand so you can
  schedule actions on **a specific static instance or a whole service/subgroup**, not just the
  whole group. Restarts with **broadcast countdowns** to players.
- **[P1] Restart-on-empty** — restart/update only when the target is **empty** (defer until the
  last player leaves, or until the scheduled window).
- **[P2] More scheduled action types** — beyond restart (e.g. backups, template re-sync, scale
  adjustments, broadcasts) — whatever's useful to automate.
- **[deferred] TimeSMP combat-logging bypass** — API to TimeSMP so a planned-interrupt restart
  temporarily disables combat-logging with a notice. *Ignore for now.*

---

## 9. Firewall — dynamic Proxmox port-forwarding + ASN filtering

Build a **firewall UI in the panel** that **dynamically creates Proxmox forwarding rules**. The
target setup: when hosted in a datacenter, the **main/edge nodes forward specific ports to the
internal services dynamically, as needed by what's running** — not a static config.

- **[P1] Dynamic port-forward by service need** — e.g. **proxies always need a forward** (it
  exists whenever the proxy service is up); **MC servers don't by default** (they're reached
  through the proxies); **web needs a dynamic forward**; **DB not by default**. So forwarding is
  driven by per-egg/service "needs-ingress" rules and appears/disappears with the service.
- **[P2] ASN-based filtering** — allow/deny by ASN (block bot/VPN hosting ranges, allow trusted).
- **Reference:** `github.com/virtbase/virtbase` — its firewall UI + logic is nice and minimal;
  model ours on that.

---

## 10. Node Placement (pin / whitelist / blacklist)

- **[P1] Extend node pinning to a mode** — today you can only **PIN** a service to a node. Make it
  a fuller placement setting with **pin / whitelist / blacklist** modes per group/service (run
  only on these nodes, or never on these). Complements the existing `splitOverNodes` spread.

---

## 11. Player Management, Audit & Logging (DSGVO)

- **[P1] Player action logging** — extensive but **low-overhead** logging of **player** actions:
  server switches, joins/leaves, block breaks/places, etc. — **CoreProtect-style but
  player-centric**, not world-centric (log per player, not full world history). Ref:
  `host.c4g7.com/server/.../player-manager`.
- **[P1] DSGVO / GDPR compliance** — retention limits, export, right-to-erasure, minimal PII.
  **Hard requirement**, since this logs real player data.

---

## 12. Resource-Pack Handling

- **[P1] RP system with a stable `latest` endpoint** — set up resource packs in the WebUI that
  **auto-apply to selected groups/services** (e.g. proxies or MC servers). Always **upload the
  newest pack** in the panel; serve it behind an **API endpoint at `…/latest`** so the **server's
  pack URL never changes and the pack UUID stays the same** — only the **SHA-1 (sha5)** updates,
  which is what the server re-applies. So clients always pull the latest from the fixed endpoint
  without reconfiguring servers.

---

## 13. Language System (i18n)

- **[P2] UI-managed language system** — a language settings UI to **import** language files,
  **edit them live**, and **create/generate new translations** in different languages. It then
  **exports the files and pushes them to the servers**, which use them directly via Conduit / the
  connector. Ref: `github.com/skydinseofficial/Language`.

---

## 14. Game-Logic Bridges (Skript connector + Ashlyn)

- **[P2] Skript ↔ Conduit connector for in-server rounds** — a system where a **single
  game-server instance** (one CT is enough) can, through the Conduit connector, **spin up multiple
  logical game rounds** on itself: dynamically assign maps/rounds, manage players, lifecycle, etc.
  — instead of one CT per round. **"Ashlyn"** = the virtual-game-rounds-per-server concept;
  there's a **reference implementation on the live node** to study.

---

## 15. Database Viewer

- **[P2] DB viewer in the panel** — a database browser inside Conduit that **auto-connects to all
  MySQL / PostgreSQL instances** hosted/managed here (managed creds), to browse/query.

---

## 16. UI / UX Polish

- **[P2] Service/server icons** — per-service icons for **Minecraft, Hytale, and web** on the
  Services/servers tab, so you can see at a glance what's running where.
- **[P2] Remove stale "refresh" buttons** — drop the top-right refresh buttons that are no longer
  needed now that the panel is live over websockets.
- **[P2] Intensify settings** — flesh out the Settings tab; e.g. make the **network name
  ("c4g7 Network")** shown at the top **editable in settings**, plus other global settings.
- **[deferred] Categories (`cats`)** — ignore for now.

---

## Deferred (explicitly not now)

- **Seamless restart / live updates (zero-downtime drain of a sharded world strip to another
  node).** Depicted in the wireframe sketch, but **LOW PRIO — ignore for now** (revisit with
  horizontal scaling).
- **TimeSMP combat-logging bypass** (see §8).
- **Categories / `cats`** (see §16).

---

## Quick priority snapshot

**P1:** version control + auto-hotfix (MC & Hytale) · global templates + rewrite-on-restart ·
subgroups (UI+API) + managed queue · maintenance in WebUI for group/subgroup/service · LuckPerms
connection + built-in editor · UI-managed Limbo + proxy try/allowed-servers · Hytale quic-relay
proxy · fine-grained schedules + restart-on-empty · dynamic Proxmox firewall forwarding · node
pin/whitelist/blacklist · player logging + DSGVO · resource-pack `latest` endpoint.

**P2:** template parenting/priority · maintenance routing · LuckPerms node grant/revoke · Hytale
auth flow · more scheduled actions · ASN firewall filtering · language system · Skript
connector / Ashlyn rounds · DB viewer · service icons · remove refresh buttons · intensify
settings.

**Deferred:** seamless restart/updates · TimeSMP combat-log bypass · categories.

---

## Open questions to pin down later

- Subgroup vs. existing "task": is a subgroup a new layer **above** tasks, or do tasks *become*
  subgroups? (Decide the data model before building the UI.)
- Where does the queue live — proxy plugin, panel, or both? How does it survive proxy restarts?
- Maintenance bypass tiers: defined in Conduit, in LuckPerms, or mirrored from both?
- Rewrite-on-restart: exactly which files are "in template scope" vs. protected persistent data?
  Need a clear include/exclude contract so an update never nukes a world or DB.
- Firewall: how do "needs-ingress" rules get declared per egg, and how do edge nodes map a
  dynamic internal service → a stable external port?
- Resource packs: confirm the UUID-stable / SHA-only-changes scheme works with modern client pack
  caching across both MC versions and Hytale.
- Ashlyn "rounds": what does a round own vs. the instance, and how does it report players back to
  Conduit (for counts/queue/maintenance)?
