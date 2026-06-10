/**
 * Server-side Proxmox VE API client for the Conduit dashboard.
 *
 * Credentials live in env (.env.local) and never reach the browser — all calls
 * go through Next.js route handlers that import this module. The Proxmox box
 * uses a self-signed cert, so we dispatch through an undici Agent that skips
 * TLS verification (dev box on the LAN only).
 */
import https from "node:https";

const HOST = process.env.PROXMOX_HOST ?? "10.27.27.126";
const PORT = Number(process.env.PROXMOX_PORT ?? "8006");
const USER = process.env.PROXMOX_USER ?? "root@pam";
const PASS = process.env.PROXMOX_PASS ?? "";
export const NODE = process.env.PROXMOX_NODE ?? "skdCore01";

// Preferred auth: a PVE API token (revocable, scoped, no CSRF). Falls back to a
// password ticket only if no token is configured. Format: USER!TOKENID = SECRET.
const TOKEN_ID = process.env.PROXMOX_TOKEN_ID ?? "";
const TOKEN_SECRET = process.env.PROXMOX_TOKEN_SECRET ?? "";
const USE_TOKEN = Boolean(TOKEN_ID && TOKEN_SECRET);

// Self-signed cert -> don't verify. Dev box on trusted LAN.
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

/** Minimal HTTPS request against the Proxmox API, returns parsed JSON. */
function rawRequest(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        port: PORT,
        path: `/api2/json${path}`,
        method,
        agent,
        headers: opts.headers,
        timeout: 30_000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json: any = {};
          try {
            json = data ? JSON.parse(data) : {};
          } catch {
            json = { _raw: data };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Proxmox request timed out")));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

type Ticket = { ticket: string; csrf: string; expires: number };
let cached: Ticket | null = null;

async function auth(): Promise<Ticket> {
  // Reuse the ticket while it's comfortably fresh (PVE tickets last ~2h).
  if (cached && cached.expires > Date.now() + 5 * 60_000) return cached;

  const body = new URLSearchParams({ username: USER, password: PASS }).toString();
  const { status, json } = await rawRequest("POST", "/access/ticket", {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  });

  if (status !== 200) throw new Error(`Proxmox auth failed: ${status}`);
  const data = json?.data;
  if (!data?.ticket) throw new Error("Proxmox auth: no ticket returned");

  cached = {
    ticket: data.ticket,
    csrf: data.CSRFPreventionToken,
    expires: Date.now() + 2 * 60 * 60_000,
  };
  return cached;
}

type ReqOpts = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** form params for write operations (url-encoded — handles net0 etc.) */
  params?: Record<string, string | number>;
};

export async function pmx<T = unknown>(path: string, opts: ReqOpts = {}): Promise<T> {
  const { method = "GET", params } = opts;

  const headers: Record<string, string> = {};
  if (USE_TOKEN) {
    // API tokens authenticate per-request and are exempt from CSRF.
    headers.Authorization = `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`;
  } else {
    const t = await auth();
    headers.Cookie = `PVEAuthCookie=${t.ticket}`;
    // Proxmox requires the CSRF token on every write (POST/PUT/DELETE).
    if (method !== "GET") headers.CSRFPreventionToken = t.csrf;
  }

  let body: string | undefined;
  if (params) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    body = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }

  const { status, json } = await rawRequest(method, path, { headers, body });
  if (status < 200 || status >= 300) {
    const msg = json?.errors
      ? JSON.stringify(json.errors)
      : json?.message ?? `HTTP ${status}`;
    throw new Error(`Proxmox ${method} ${path} -> ${status}: ${msg}`);
  }
  return json.data as T;
}

/* ---- typed domain helpers ------------------------------------------------ */

export type PveNode = {
  node: string;
  status: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
};

export type ClusterResource = {
  id: string;
  type: "node" | "lxc" | "qemu" | "storage" | "sdn" | string;
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  maxdisk?: number;
  disk?: number;
  uptime?: number;
  template?: number;
  tags?: string;
  pool?: string;
};

export type Template = {
  volid: string;
  size?: number;
  format?: string;
};

/** One RRD sample. cpu is a 0..1 fraction; bytes for memory/net. NOTE: node rrddata uses
 *  memused/memtotal, while guest (lxc/qemu) rrddata uses mem/maxmem — both are included. */
export type RrdPoint = {
  time: number; cpu?: number; maxcpu?: number;
  mem?: number; maxmem?: number; memused?: number; memtotal?: number;
  netin?: number; netout?: number; diskread?: number; diskwrite?: number;
};

/** Stable node ordering by name (numeric + case-insensitive): skdCore01 < SkdCore02 < SkdCore03. */
export const byNodeName = (a: { node: string }, b: { node: string }) =>
  a.node.localeCompare(b.node, undefined, { numeric: true, sensitivity: "base" });

export const api = {
  // Sorted so the UI node list never reshuffles between polls (PVE returns arbitrary order).
  nodes: async () => (await pmx<PveNode[]>("/nodes")).sort(byNodeName),
  clusterResources: () => pmx<ClusterResource[]>("/cluster/resources"),
  clusterStatus: () =>
    pmx<{ type: string; name?: string; ip?: string; online?: number; local?: number }[]>(
      "/cluster/status",
    ),
  nodeStatus: (node = NODE) => pmx<Record<string, unknown>>(`/nodes/${node}/status`),
  lxcStatus: (vmid: number, node = NODE) =>
    pmx<Record<string, unknown>>(`/nodes/${node}/lxc/${vmid}/status/current`),
  // RRD time-series. timeframe ∈ hour|day|week|month|year (Proxmox's fixed resolutions);
  // each point has { time, cpu (0..1), maxcpu, mem, maxmem, netin, netout, ... }.
  lxcRrd: (vmid: number, timeframe: string, node = NODE) =>
    pmx<RrdPoint[]>(`/nodes/${node}/lxc/${vmid}/rrddata?timeframe=${timeframe}&cf=AVERAGE`),
  nodeRrd: (timeframe: string, node = NODE) =>
    pmx<RrdPoint[]>(`/nodes/${node}/rrddata?timeframe=${timeframe}&cf=AVERAGE`),
  lxcAction: (vmid: number, action: "start" | "stop" | "shutdown" | "reboot", node = NODE) =>
    pmx<string>(`/nodes/${node}/lxc/${vmid}/status/${action}`, { method: "POST" }),
  lxcInterfaces: (vmid: number, node = NODE) =>
    pmx<{ name: string; inet?: string; "hwaddr"?: string }[]>(
      `/nodes/${node}/lxc/${vmid}/interfaces`,
    ),
  templates: (storage = "local", node = NODE) =>
    pmx<Template[]>(`/nodes/${node}/storage/${storage}/content?content=vztmpl`),
  storage: (node = NODE) =>
    pmx<{ storage: string; type: string; content: string; avail?: number; total?: number; used?: number }[]>(
      `/nodes/${node}/storage`,
    ),
  createLxc: (params: Record<string, string | number>, node = NODE) =>
    pmx<string>(`/nodes/${node}/lxc`, { method: "POST", params }),
  deleteLxc: (vmid: number, node = NODE) =>
    pmx<string>(`/nodes/${node}/lxc/${vmid}?purge=1&force=1`, { method: "DELETE" }),
  /** Migrate a container to another node. restart=1 does a (brief) restart-migration, which
   *  works for running CTs on local storage; offline for stopped ones. */
  migrateLxc: (vmid: number, target: string, node = NODE) =>
    pmx<string>(`/nodes/${node}/lxc/${vmid}/migrate`, {
      method: "POST",
      params: { target, restart: 1 },
    }),
  /** Full-clone a (stopped) container to a new vmid on the same node. */
  cloneLxc: (vmid: number, newid: number, params: Record<string, string | number>, node = NODE) =>
    pmx<string>(`/nodes/${node}/lxc/${vmid}/clone`, {
      method: "POST",
      params: { newid, full: 1, ...params },
    }),
  /** Restore an LXC from a backup archive (overwrites the target vmid). */
  restoreLxc: (vmid: number, archive: string, storage = "local-lvm", node = NODE) =>
    pmx<string>(`/nodes/${node}/lxc`, {
      method: "POST",
      params: { vmid, ostemplate: archive, restore: 1, force: 1, storage },
    }),
  lxcConfig: (vmid: number, node = NODE) =>
    pmx<Record<string, unknown>>(`/nodes/${node}/lxc/${vmid}/config`),
  setLxcConfig: (vmid: number, params: Record<string, string | number>, node = NODE) =>
    pmx<null>(`/nodes/${node}/lxc/${vmid}/config`, { method: "PUT", params }),

  // pools (= server groups)
  pools: () => pmx<{ poolid: string }[]>("/pools"),
  createPool: (poolid: string, comment = "") =>
    pmx<null>("/pools", { method: "POST", params: { poolid, comment } }),
  deletePool: (poolid: string) =>
    pmx<null>(`/pools/${poolid}`, { method: "DELETE" }),

  // backups (vzdump → PBS/local storage) + scheduled jobs
  storageContent: (storage: string, content = "backup", node = NODE) =>
    pmx<
      { volid: string; vmid?: number; ctime?: number; size?: number; notes?: string; format?: string }[]
    >(`/nodes/${node}/storage/${storage}/content?content=${content}`),
  vzdump: (params: Record<string, string | number>, node = NODE) =>
    pmx<string>(`/nodes/${node}/vzdump`, { method: "POST", params }),
  deleteBackup: (storage: string, volid: string, node = NODE) =>
    pmx<string>(
      `/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`,
      { method: "DELETE" },
    ),
  backupStorages: (node = NODE) =>
    pmx<{ storage: string; type: string; content: string; avail?: number; total?: number; used?: number }[]>(
      `/nodes/${node}/storage?content=backup`,
    ),
  backupJobs: () =>
    pmx<
      { id: string; schedule?: string; storage?: string; pool?: string; enabled?: number; mode?: string; comment?: string }[]
    >("/cluster/backup"),
  createBackupJob: (params: Record<string, string | number>) =>
    pmx<null>("/cluster/backup", { method: "POST", params }),
  deleteBackupJob: (id: string) =>
    pmx<null>(`/cluster/backup/${id}`, { method: "DELETE" }),

  // task status (UPID)
  taskStatus: (upid: string, node = NODE) =>
    pmx<{ status: string; exitstatus?: string }>(
      `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
    ),

  /** Lowest free VMID inside [from, to], skipping anything in use. */
  async nextVmid(from = 200, to = 999): Promise<number> {
    const res = await api.clusterResources();
    const used = new Set(
      res.filter((r) => r.vmid != null).map((r) => r.vmid as number),
    );
    for (let id = from; id <= to; id++) if (!used.has(id)) return id;
    throw new Error("no free VMID in range");
  },
};

// node name → IP for SSH/pct-exec, learned from /cluster/status (cached ~60s).
// The local node falls back to the configured PROXMOX_HOST.
let nodeIpCache: { at: number; map: Map<string, string> } | null = null;
export async function nodeIp(node: string): Promise<string> {
  if (!nodeIpCache || Date.now() - nodeIpCache.at > 60_000) {
    const map = new Map<string, string>();
    try {
      for (const m of await api.clusterStatus()) {
        if (m.type === "node" && m.name && m.ip) map.set(m.name, m.ip);
      }
    } catch {
      /* single-node / not clustered — map stays empty, fall back below */
    }
    nodeIpCache = { at: Date.now(), map };
  }
  return nodeIpCache.map.get(node) ?? (node === NODE ? HOST : HOST);
}

/** SSH host (IP) for the node that currently runs a given vmid. */
export async function vmidHost(vmid: number): Promise<string> {
  const res = await api.clusterResources().catch(() => []);
  const ct = res.find((r) => r.vmid === vmid && r.node);
  return ct?.node ? nodeIp(ct.node) : HOST;
}

/** Proxmox NODE NAME (e.g. "SkdCore03", not the IP) hosting a given vmid — for API paths. */
export async function vmidNode(vmid: number): Promise<string | null> {
  const res = await api.clusterResources().catch(() => []);
  return res.find((r) => r.vmid === vmid && r.node)?.node ?? null;
}

/** Wait for a Proxmox task (UPID) to finish; returns exit status. */
export async function waitTask(upid: string, node = NODE, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await api.taskStatus(upid, node).catch(() => null);
    if (s && s.status === "stopped") return s.exitstatus ?? "OK";
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`task ${upid} timed out`);
}

/** First IPv4 of a running container's eth0, or null if not up yet. */
export async function lxcIp(vmid: number, node = NODE): Promise<string | null> {
  try {
    const ifaces = await api.lxcInterfaces(vmid, node);
    const eth = ifaces.find((i) => i.name === "eth0") ?? ifaces[0];
    const inet = eth?.inet;
    if (!inet) return null;
    return inet.split("/")[0];
  } catch {
    return null;
  }
}
