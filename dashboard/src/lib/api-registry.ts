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
  "Infrastructure",
  "Console & Files",
  "Backups",
] as const;

export const API_ENDPOINTS: ApiEndpoint[] = [
  // ── Conduit ──────────────────────────────────────────────────────────
  { method: "GET", path: "/api/conduit/state", group: "Conduit", safe: true, desc: "Full desired + live state (groups → servers → instances, routing, blueprints)." },
  { method: "POST", path: "/api/conduit/reconcile", group: "Conduit", desc: "Force a reconcile tick now (engine converges Proxmox to desired state)." },
  { method: "GET", path: "/api/overview", group: "Conduit", safe: true, desc: "Cluster KPIs: nodes, containers, memory, players." },
  { method: "GET", path: "/api/metrics", group: "Conduit", safe: true, desc: "Live player counts + per-instance SLP sample." },
  { method: "GET", path: "/api/metrics/history", group: "Conduit", safe: true, desc: "Rolling cluster sparkline history (players/cpu/mem)." },

  // ── Servers (tasks/groups) ───────────────────────────────────────────
  { method: "GET", path: "/api/groups", group: "Servers", safe: true, desc: "All groups." },
  { method: "POST", path: "/api/groups", group: "Servers", desc: "Create a group.", sampleBody: { name: "Demo Group" } },
  { method: "PATCH", path: "/api/groups/:id", group: "Servers", desc: "Update a group (maintenance, slot limit, name).", params: [{ name: "id", example: "time-smp" }], sampleBody: { maintenance: false } },
  { method: "DELETE", path: "/api/groups/:id", group: "Servers", destructive: true, desc: "Delete a group and all its servers + instances.", params: [{ name: "id", example: "time-smp" }] },
  { method: "POST", path: "/api/tasks", group: "Servers", desc: "Create a server (task) from a blueprint.", sampleBody: { name: "demo", groupId: "time-smp", blueprintId: "paper-smp", mode: "static", min: 1, max: 1 } },
  { method: "PATCH", path: "/api/tasks/:id", group: "Servers", desc: "Update a server: scale (delta/desired), resources, fronts, seed, software.", params: [{ name: "id", example: "time-smp-smp" }], sampleBody: { delta: 0 } },
  { method: "DELETE", path: "/api/tasks/:id", group: "Servers", destructive: true, desc: "Delete a server and destroy its instances.", params: [{ name: "id", example: "time-smp-smp" }] },
  { method: "POST", path: "/api/tasks/:id/motd", group: "Servers", desc: "Set the MOTD (live velocity reload for proxies).", params: [{ name: "id", example: "time-smp-proxy" }], sampleBody: { motd: "Conduit &bnetwork" } },

  // ── Infrastructure ───────────────────────────────────────────────────
  { method: "GET", path: "/api/containers", group: "Infrastructure", safe: true, desc: "All LXC instances across the cluster." },
  { method: "POST", path: "/api/containers/:vmid/action", group: "Infrastructure", desc: "start | stop | shutdown | reboot a container.", params: [{ name: "vmid", example: "202" }], sampleBody: { action: "reboot", node: "skdCore01" } },
  { method: "GET", path: "/api/blueprints", group: "Infrastructure", safe: true, desc: "Server eggs (built-in + custom)." },
  { method: "POST", path: "/api/blueprints", group: "Infrastructure", desc: "Create a custom egg.", sampleBody: { name: "Custom", role: "smp", software: { kind: "paper", version: "1.20.4" } } },
  { method: "DELETE", path: "/api/blueprints/:id", group: "Infrastructure", destructive: true, desc: "Delete a custom egg.", params: [{ name: "id", example: "custom" }] },
  { method: "GET", path: "/api/templates", group: "Infrastructure", safe: true, desc: "Node storage + LXC base images." },
  { method: "GET", path: "/api/versions", group: "Infrastructure", safe: true, query: "kind=paper", desc: "Available software versions for a kind (paper/velocity)." },
  { method: "GET", path: "/api/assets", group: "Infrastructure", safe: true, desc: "Uploaded worlds/plugins/configs." },

  // ── Console & Files ──────────────────────────────────────────────────
  { method: "GET", path: "/api/services/:vmid/agent", group: "Console & Files", safe: true, desc: "Resolve which node agent + console port serves a container.", params: [{ name: "vmid", example: "202" }] },
  { method: "GET", path: "/api/services/:vmid/files", group: "Console & Files", safe: true, query: "path=/opt/mc", desc: "List a directory inside a container (sandboxed to /opt).", params: [{ name: "vmid", example: "202" }] },
  { method: "POST", path: "/api/services/:vmid/console", group: "Console & Files", desc: "Send a command line to the server console.", params: [{ name: "vmid", example: "202" }], sampleBody: { command: "list" } },
  { method: "GET", path: "/api/services/:vmid/console/stream", group: "Console & Files", stream: true, desc: "SSE: live console output stream.", params: [{ name: "vmid", example: "202" }] },
  { method: "GET", path: "/api/services/:vmid/install-log", group: "Console & Files", stream: true, desc: "SSE: provisioning install log stream.", params: [{ name: "vmid", example: "203" }] },

  // ── Backups ──────────────────────────────────────────────────────────
  { method: "GET", path: "/api/backups", group: "Backups", safe: true, desc: "Snapshots on the backup store." },
  { method: "POST", path: "/api/backups", group: "Backups", desc: "Create an on-demand backup.", sampleBody: { vmid: 202, node: "skdCore01" } },
  { method: "POST", path: "/api/backups/jobs", group: "Backups", desc: "Schedule a recurring backup job.", sampleBody: { schedule: "03:00", vmid: 202 } },
  { method: "POST", path: "/api/backups/restore", group: "Backups", destructive: true, desc: "Restore a container from a snapshot.", sampleBody: { volid: "…", vmid: 202, node: "skdCore01" } },
];
