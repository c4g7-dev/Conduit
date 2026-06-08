/**
 * Client for the Conduit Node Agent (see /agent).
 *
 * Each Proxmox host runs conduit-agent on CONDUIT_AGENT_PORT. The dashboard
 * prefers the agent for console + exec (real-time WS, local pct exec) and falls
 * back to SSH when an agent is unreachable.
 */
import { WebSocket } from "ws";

const TOKEN = process.env.CONDUIT_AGENT_TOKEN ?? "";
const PORT = Number(process.env.CONDUIT_AGENT_PORT ?? 8800);

export function agentConfigured(): boolean {
  return TOKEN.length > 0;
}

function base(host: string): string {
  return `http://${host}:${PORT}`;
}

/** Short-lived reachability cache so we don't probe a dead agent on every call. */
const upCache = new Map<string, { at: number; up: boolean }>();
const UP_TTL = 15_000;

export async function agentUp(host: string): Promise<boolean> {
  if (!agentConfigured()) return false;
  const cached = upCache.get(host);
  if (cached && Date.now() - cached.at < UP_TTL) return cached.up;
  let up = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2_000);
    const res = await fetch(`${base(host)}/v1/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    up = res.ok;
  } catch {
    up = false;
  }
  upCache.set(host, { at: Date.now(), up });
  return up;
}

export type ExecResult = { code: number; stdout: string; stderr: string };

/** Run a command via the agent — inside a CT when vmid is given, else on the host. */
export async function agentExec(
  host: string,
  cmd: string,
  opts: { vmid?: number; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (opts.timeoutMs ?? 30_000) + 2_000);
  try {
    const res = await fetch(`${base(host)}/v1/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cmd, vmid: opts.vmid, timeoutMs: opts.timeoutMs }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`agent exec ${res.status}`);
    return (await res.json()) as ExecResult;
  } finally {
    clearTimeout(t);
  }
}

/** Read the shared Conduit state JSON from an agent (backed by /etc/pve/conduit). */
export async function agentGetState<T = unknown>(host: string): Promise<T> {
  const res = await fetch(`${base(host)}/v1/state`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`agent state GET ${res.status}`);
  return (await res.json()) as T;
}

/** Atomically replace the shared Conduit state JSON via an agent. */
export async function agentPutState(host: string, state: unknown): Promise<void> {
  const res = await fetch(`${base(host)}/v1/state`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`agent state PUT ${res.status}`);
}

/* ---- File manager (shared store, sandboxed to /var/lib/conduit) ----------- */

/** The node whose agent serves the shared-store file manager (any node sees the gluster mount). */
export function fsAgentHost(): string {
  return process.env.CONDUIT_STATE_AGENT || process.env.PROXMOX_HOST || "10.27.27.126";
}

export type FsEntry = { name: string; type: "dir" | "file"; size: number; mtime: number };

async function fsFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${base(fsAgentHost())}/v1/fs${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`agent fs ${res.status}`);
  return res.json();
}

export async function fsList(path: string): Promise<{ path: string; entries: FsEntry[] }> {
  return fsFetch(`?path=${encodeURIComponent(path)}`);
}
export async function fsRead(path: string): Promise<{ content: string; size: number; truncated: boolean }> {
  return fsFetch(`/read?path=${encodeURIComponent(path)}`);
}
export async function fsWrite(path: string, content: string): Promise<void> {
  await fsFetch(`/write`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }) });
}
export async function fsMkdir(path: string): Promise<void> {
  await fsFetch(`/mkdir`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
}
export async function fsDelete(paths: string | string[]): Promise<void> {
  const body = Array.isArray(paths) ? { paths } : { path: paths };
  await fsFetch(`/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
export async function fsMove(from: string, to: string): Promise<void> {
  await fsFetch(`/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }) });
}
export async function fsCopy(from: string, to: string): Promise<void> {
  await fsFetch(`/copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }) });
}
export async function fsUpload(dir: string, name: string, contentB64: string): Promise<void> {
  await fsFetch(`/upload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir, name, content: contentB64 }) });
}
export async function fsArchive(dir: string, names: string[], dest: string): Promise<void> {
  await fsFetch(`/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir, names, dest }) });
}
export async function fsExtract(path: string): Promise<void> {
  await fsFetch(`/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
}
/** Server-side: stream a download from the agent (panel proxies it; token stays server-side). */
export async function fsDownloadResponse(path: string): Promise<Response> {
  return fetch(`${base(fsAgentHost())}/v1/fs/download?path=${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

export type ConsoleFrame = { type: "history" | "output" | "ready" | "pong"; data: unknown };

/**
 * Open a real-time console WebSocket to the agent for a container.
 * Caller wires onFrame / onClose and uses send() for input. Returns a closer.
 */
export function agentConsole(
  host: string,
  vmid: number,
  handlers: {
    onFrame: (frame: ConsoleFrame) => void;
    onClose?: () => void;
    onError?: (e: unknown) => void;
  },
): { send: (input: string) => void; close: () => void } {
  const url = `ws://${host}:${PORT}/v1/console?vmid=${vmid}&token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(url);

  ws.on("message", (raw: Buffer) => {
    try {
      handlers.onFrame(JSON.parse(raw.toString()) as ConsoleFrame);
    } catch {
      /* ignore malformed */
    }
  });
  ws.on("close", () => handlers.onClose?.());
  ws.on("error", (e) => handlers.onError?.(e));

  return {
    send: (input: string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: input }));
      }
    },
    close: () => {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}
