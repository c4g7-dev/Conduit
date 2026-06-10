/**
 * Registry of Conduit's HTTP API, driving the in-panel API explorer (/apis).
 * `safe` GETs are auto-run on select; mutations require an explicit confirm.
 * `stream` endpoints are Server-Sent-Event streams (not runnable in the simple debugger).
 */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiEndpoint = {
  method: Method;
  path: string; // template, e.g. /api/tasks/:id
  group: string;
  desc: string;
  safe?: boolean; // auto-run (read-only GET)
  destructive?: boolean; // extra confirm
  stream?: boolean; // SSE — not runnable here
  params?: { name: string; example: string }[];
  query?: string; // default query string (without leading ?)
  sampleBody?: unknown;
};

export const API_GROUPS = [
  "Conduit",
  "Servers",
  "Players & Connector",
  "Automation",
  "Infrastructure",
  "Console & Files",
  "Backups",
] as const;

export const API_ENDPOINTS: ApiEndpoint[] = [
  // ── Conduit ──────────────────────────────────────────────────────────
  { method: "GET", path: "/api/conduit/state", group: "Conduit", safe: true, desc: "Full desired + live state (groups → servers → instances, routing, blueprints)." },
  { method: "POST", path: "/api/conduit/reconcile", group: "Conduit", desc: "Force a reconcile tick now (engine converges Proxmox to desired state)." },
  { method: "GET", path: "/api/overview", group: "Conduit", safe: true, desc: "Cluster KPIs: nodes, containers, memory, players." },
  { method: "GET", path: "/api/metrics", group: "Conduit", safe: true, desc: "Live per-instance player counts + reachability (connector-sourced)." },
  { method: "GET", path: "/api/metrics/history", group: "Conduit", safe: true, query: "range=1h", desc: "Time-series metrics. ?range=5m|1h|24h|30d (+?vmid= for one container): cpu/mem from Proxmox RRD, players/containers from the sampler." },

  // ── Servers (tasks/groups) ───────────────────────────────────────────
  { method: "GET", path: "/api/groups", group: "Servers", safe: true, desc: "All groups." },
  { method: "POST", path: "/api/groups", group: "Servers", desc: "Create a group.", sampleBody: { name: "Demo Group" } },
  { method: "PATCH", path: "/api/groups/:id", group: "Servers", desc: "Update a group (maintenance, slot limit, name).", params: [{ name: "id", example: "time-smp" }], sampleBody: { maintenance: false } },
  { method: "DELETE", path: "/api/groups/:id", group: "Servers", destructive: true, desc: "Delete a group and all its servers + instances.", params: [{ name: "id", example: "time-smp" }] },
  { method: "POST", path: "/api/groups/:id/subgroups", group: "Servers", desc: "Create a subgroup (Untergruppe) — an addressable bucket of servers inside the group for targeted maintenance/ops.", params: [{ name: "id", example: "network" }], sampleBody: { name: "Time SMP" } },
  { method: "PATCH", path: "/api/groups/:id/subgroups/:sgId", group: "Servers", desc: "Update a subgroup (maintenance, rename). Maintenance cascades to its servers — the proxy denies connects unless conduit.maintenance.bypass[.<task>].", params: [{ name: "id", example: "network" }, { name: "sgId", example: "time-smp" }], sampleBody: { maintenance: true } },
  { method: "DELETE", path: "/api/groups/:id/subgroups/:sgId", group: "Servers", desc: "Delete a subgroup. Its servers stay and rejoin the group directly (no instances touched).", params: [{ name: "id", example: "network" }, { name: "sgId", example: "time-smp" }] },
  { method: "POST", path: "/api/tasks", group: "Servers", desc: "Create a server (task) from a blueprint.", sampleBody: { name: "demo", groupId: "time-smp", blueprintId: "paper-smp", mode: "static", min: 1, max: 1 } },
  { method: "PATCH", path: "/api/tasks/:id", group: "Servers", desc: "Update a server: scale (delta/desired), resources, fronts, seed, software, subgroupId, maintenance.", params: [{ name: "id", example: "time-smp-smp" }], sampleBody: { delta: 0 } },
  { method: "DELETE", path: "/api/tasks/:id", group: "Servers", destructive: true, desc: "Delete a server and destroy its instances.", params: [{ name: "id", example: "time-smp-smp" }] },
  { method: "POST", path: "/api/tasks/:id/motd", group: "Servers", desc: "Set the MOTD (live velocity reload for proxies).", params: [{ name: "id", example: "time-smp-proxy" }], sampleBody: { motd: "Conduit &bnetwork" } },
  { method: "GET", path: "/api/tasks/:id/sharding", group: "Servers", safe: true, desc: "Live world-sharding config + computed strip grid (regions, X-ranges, per-region online).", params: [{ name: "id", example: "network-world" }] },
  { method: "POST", path: "/api/tasks/:id/sharding", group: "Servers", destructive: true, desc: "Enable sharding: apply a shared seed across all region instances and regenerate their worlds (destructive).", params: [{ name: "id", example: "network-world" }], sampleBody: { seed: "" } },

  // ── Players & Connector ──────────────────────────────────────────────
  { method: "GET", path: "/api/players", group: "Players & Connector", safe: true, desc: "Network player list (full, connector-sourced, with UUIDs)." },
  { method: "GET", path: "/api/connector/servers", group: "Players & Connector", safe: true, desc: "Live connector-registered servers + flattened players." },
  { method: "GET", path: "/api/stream", group: "Players & Connector", stream: true, desc: "SSE: live connector state (servers + players) pushed on every change." },
  { method: "POST", path: "/api/connector/action", group: "Players & Connector", desc: "Queue a player action: move/message/broadcast/kick (scoped to the player's server via serverId/env).", sampleBody: { kind: "message", player: "Notch", text: "hello", serverId: "network-lobby-201", env: "server" } },
  { method: "GET", path: "/api/connector/move-targets", group: "Players & Connector", safe: true, query: "server=world&group=network", desc: "Compatible servers a player can be moved to (same game kind, proxies excluded)." },
  { method: "POST", path: "/api/connector/register", group: "Players & Connector", desc: "(plugin) Register a service. Token-auth.", sampleBody: { id: "Lobby-1", task: "lobby", group: "Network", env: "server" } },
  { method: "POST", path: "/api/connector/heartbeat", group: "Players & Connector", desc: "(plugin) Heartbeat with players/counts/tps; proxy gets pending actions + routing/MOTD config. Token-auth.", sampleBody: { id: "Lobby-1", online: 0, max: 50, players: [] } },
  { method: "POST", path: "/api/connector/event", group: "Players & Connector", desc: "(plugin) join/quit/switch event → Activity feed. Token-auth.", sampleBody: { type: "join", player: "Notch", server: "lobby" } },
  { method: "POST", path: "/api/connector/transfer", group: "Players & Connector", desc: "(plugin, sharding) Report a strip-boundary cross: stash coords + queue a proxy move to the owning region. Token-auth.", sampleBody: { player: "Notch", target: "world-204", targetServerId: "network-world-204", loc: "24955;74;121;world;0;0" } },
  { method: "GET", path: "/api/connector/pending", group: "Players & Connector", desc: "(plugin, sharding) Pending coord-restores for a destination instance; ?ack=names clears them. Token-auth.", query: "id=network-world-204" },
  { method: "POST", path: "/api/connector/maintenance", group: "Players & Connector", desc: "(plugin) /conduit maintenance <target> <on|off> — resolves a group, subgroup or server by name and toggles its maintenance. Token-auth.", sampleBody: { target: "timesmp", on: true } },

  // ── Automation ───────────────────────────────────────────────────────
  { method: "GET", path: "/api/luckperms/status", group: "Automation", safe: true, desc: "LuckPerms link health: Postgres storage reachability, schema state, group/user/track counts, Redis messaging endpoint." },
  { method: "POST", path: "/api/luckperms/install", group: "Automation", desc: "Install/refresh LuckPerms on every running Paper + Velocity instance (Postgres storage + Redis messaging wired automatically; each server restarts).", sampleBody: {} },
  { method: "GET", path: "/api/luckperms/groups", group: "Automation", safe: true, desc: "Permission groups with weight/prefix/parents summaries (the built-in LP editor)." },
  { method: "POST", path: "/api/luckperms/groups", group: "Automation", desc: "Create a permission group (lp creategroup equivalent; triggers networksync).", sampleBody: { name: "vip" } },
  { method: "GET", path: "/api/luckperms/groups/:name", group: "Automation", safe: true, desc: "A group's full node list.", params: [{ name: "name", example: "default" }] },
  { method: "POST", path: "/api/luckperms/groups/:name", group: "Automation", desc: "Add a node to a group: permission/value/server/world/expiry (networksync).", params: [{ name: "name", example: "default" }], sampleBody: { permission: "conduit.maintenance.bypass", value: true } },
  { method: "DELETE", path: "/api/luckperms/groups/:name", group: "Automation", desc: "Remove a node (body) — or delete the group entirely with ?group=1.", params: [{ name: "name", example: "vip" }], sampleBody: { permission: "conduit.maintenance.bypass" } },
  { method: "GET", path: "/api/luckperms/users", group: "Automation", safe: true, query: "q=c4g", desc: "Search known players (joined at least once) by name prefix." },
  { method: "GET", path: "/api/luckperms/users/:uuid", group: "Automation", safe: true, desc: "A user's identity + node list.", params: [{ name: "uuid", example: "00000000-0000-0000-0000-000000000000" }] },
  { method: "POST", path: "/api/luckperms/users/:uuid", group: "Automation", desc: "Add a node to a user, or set { primaryGroup } (networksync).", params: [{ name: "uuid", example: "00000000-0000-0000-0000-000000000000" }], sampleBody: { permission: "conduit.admin", value: true } },
  { method: "DELETE", path: "/api/luckperms/users/:uuid", group: "Automation", desc: "Remove a node from a user (networksync).", params: [{ name: "uuid", example: "00000000-0000-0000-0000-000000000000" }], sampleBody: { permission: "conduit.admin" } },
  { method: "GET", path: "/api/luckperms/tracks", group: "Automation", safe: true, desc: "Promotion tracks (ordered group ladders for /lp promote)." },
  { method: "POST", path: "/api/luckperms/tracks", group: "Automation", desc: "Create/replace a track's ladder, low → high (networksync).", sampleBody: { name: "staff", groups: ["helper", "mod", "admin"] } },
  { method: "DELETE", path: "/api/luckperms/tracks", group: "Automation", desc: "Delete a track.", sampleBody: { name: "staff" } },
  { method: "GET", path: "/api/activity", group: "Automation", safe: true, desc: "Engine event feed + derived health alerts." },
  { method: "GET", path: "/api/schedules", group: "Automation", safe: true, desc: "Scheduled restarts/broadcasts." },
  { method: "POST", path: "/api/schedules", group: "Automation", desc: "Create a schedule (restart/broadcast, daily HH:MM, warnings).", sampleBody: { name: "Nightly", groupId: "network", action: "restart", at: "04:00", warnMins: [5, 1] } },
  { method: "PATCH", path: "/api/schedules/:id", group: "Automation", desc: "Update/toggle a schedule.", params: [{ name: "id", example: "nightly-ab12" }], sampleBody: { enabled: false } },
  { method: "DELETE", path: "/api/schedules/:id", group: "Automation", destructive: true, desc: "Delete a schedule.", params: [{ name: "id", example: "nightly-ab12" }] },
  { method: "POST", path: "/api/groups/:id/broadcast", group: "Automation", desc: "Broadcast a console command to every running server in a group.", params: [{ name: "id", example: "network" }], sampleBody: { command: "say hello" } },

  // ── Infrastructure ───────────────────────────────────────────────────
  { method: "GET", path: "/api/nodes", group: "Infrastructure", safe: true, desc: "Proxmox nodes (name + online status)." },
  { method: "GET", path: "/api/containers", group: "Infrastructure", safe: true, desc: "All LXC instances across the cluster." },
  { method: "POST", path: "/api/containers/:vmid/action", group: "Infrastructure", desc: "start | stop | shutdown | reboot a container.", params: [{ name: "vmid", example: "202" }], sampleBody: { action: "reboot", node: "skdCore01" } },
  { method: "POST", path: "/api/containers/:vmid/migrate", group: "Infrastructure", desc: "Live-migrate a container to another node.", params: [{ name: "vmid", example: "202" }], sampleBody: { target: "SkdCore02" } },
  { method: "DELETE", path: "/api/containers/:vmid", group: "Infrastructure", destructive: true, desc: "Permanently delete an instance + purge its disk; lowers the task target so it isn't recreated.", params: [{ name: "vmid", example: "207" }] },
  { method: "GET", path: "/api/blueprints", group: "Infrastructure", safe: true, desc: "Server eggs (built-in + custom)." },
  { method: "POST", path: "/api/blueprints", group: "Infrastructure", desc: "Create a custom egg.", sampleBody: { name: "Custom", role: "smp", software: { kind: "paper", version: "1.20.4" } } },
  { method: "GET", path: "/api/images", group: "Infrastructure", safe: true, desc: "Golden-image build status per egg (fast clone autoscaling)." },
  { method: "POST", path: "/api/images/build", group: "Infrastructure", desc: "Build/refresh an egg's golden CT template on every node (async).", sampleBody: { eggId: "paper-smp" } },
  { method: "DELETE", path: "/api/blueprints/:id", group: "Infrastructure", destructive: true, desc: "Delete a custom egg.", params: [{ name: "id", example: "custom" }] },
  { method: "GET", path: "/api/templates", group: "Infrastructure", safe: true, desc: "Node storage + LXC base images." },
  { method: "GET", path: "/api/versions", group: "Infrastructure", safe: true, query: "kind=paper", desc: "Available software versions for a kind (paper/velocity)." },
  { method: "GET", path: "/api/assets", group: "Infrastructure", safe: true, desc: "Uploaded worlds/plugins/configs." },

  // ── Console & Files ──────────────────────────────────────────────────
  { method: "GET", path: "/api/services/:vmid/agent", group: "Console & Files", safe: true, desc: "Resolve which node agent + console port serves a container.", params: [{ name: "vmid", example: "202" }] },
  { method: "GET", path: "/api/services/:vmid/files", group: "Console & Files", safe: true, query: "path=/opt/mc", desc: "List a dir inside a container (?file=1 read, ?download=1 download).", params: [{ name: "vmid", example: "202" }] },
  { method: "POST", path: "/api/services/:vmid/files", group: "Console & Files", desc: "Container file op: mkdir|delete|move|copy|upload|archive|extract.", params: [{ name: "vmid", example: "202" }], sampleBody: { action: "mkdir", path: "/opt/mc/newdir" } },
  { method: "POST", path: "/api/services/:vmid/share", group: "Console & Files", desc: "Bind the service's config/plugins onto the shared store (/opt/shared); reboots the CT once.", params: [{ name: "vmid", example: "202" }] },
  { method: "GET", path: "/api/files", group: "Console & Files", safe: true, query: "path=overlays", desc: "Shared store: list (?file=1 read, ?download=1 download a file/dir-as-zip)." },
  { method: "PUT", path: "/api/files", group: "Console & Files", desc: "Shared store: write a file.", sampleBody: { path: "overlays/demo.txt", content: "hello" } },
  { method: "POST", path: "/api/files", group: "Console & Files", desc: "Shared store file op: mkdir|delete|move|copy|upload|archive|extract.", sampleBody: { action: "mkdir", path: "overlays/demo" } },
  { method: "POST", path: "/api/services/:vmid/console", group: "Console & Files", desc: "Send a command line to the server console.", params: [{ name: "vmid", example: "202" }], sampleBody: { command: "list" } },
  { method: "GET", path: "/api/services/:vmid/console/stream", group: "Console & Files", stream: true, desc: "SSE: live console output stream.", params: [{ name: "vmid", example: "202" }] },
  { method: "GET", path: "/api/services/:vmid/install-log", group: "Console & Files", stream: true, desc: "SSE: provisioning install log stream.", params: [{ name: "vmid", example: "203" }] },

  // ── Backups ──────────────────────────────────────────────────────────
  { method: "GET", path: "/api/backups", group: "Backups", safe: true, desc: "Snapshots on the backup store." },
  { method: "POST", path: "/api/backups", group: "Backups", desc: "Create an on-demand backup.", sampleBody: { vmid: 202, node: "skdCore01" } },
  { method: "POST", path: "/api/backups/jobs", group: "Backups", desc: "Schedule a recurring backup job.", sampleBody: { schedule: "03:00", vmid: 202 } },
  { method: "DELETE", path: "/api/backups/jobs/:id", group: "Backups", destructive: true, desc: "Delete a scheduled backup job.", params: [{ name: "id", example: "backup-202" }] },
  { method: "POST", path: "/api/backups/restore", group: "Backups", destructive: true, desc: "Restore a container from a snapshot.", sampleBody: { volid: "…", vmid: 202, node: "skdCore01" } },
];
