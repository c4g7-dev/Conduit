/**
 * In-memory registry fed by the Conduit connector plugin (Paper + Velocity), mirroring
 * CloudNet-Bridge. Servers register on enable and heartbeat with full player lists; the panel
 * reads this for rich player/server data (beyond what SLP's ~12-name sample can give) and
 * queues actions (move/message/kick) the plugin polls.
 *
 * Lives on a Node global so it survives Next hot-reloads and is shared across route handlers
 * in one process. The VIP-holding panel is the one the plugins talk to.
 */
export type ConnPlayer = { uuid: string; name: string; server?: string; serverId?: string; ping?: number };
export type ConnServer = {
  id: string;            // service id, e.g. "Lobby-1" or the conduit task-instance id
  task: string;          // task/egg name
  group: string;         // group name
  env: "proxy" | "server" | "hytale";
  node?: string;
  ip?: string;
  port?: number;
  online: number;
  max: number;
  tps?: number;
  players: ConnPlayer[];
  lastSeen: number;
};
// `serverId` + `env` scope an action to the player's CURRENT server so the right executor runs
// it. Without this, a player-name action (e.g. kick c4g7) was drained by BOTH the proxy and the
// Hytale connector, kicking same-named players on both platforms. Now: env="hytale" actions are
// executed only by the Hytale connector whose self id == serverId; all others by the proxy.
export type ConnAction =
  | { id: number; kind: "move"; player: string; target: string; serverId?: string; env?: string }
  | { id: number; kind: "message"; player: string; text: string; serverId?: string; env?: string }
  | { id: number; kind: "broadcast"; group?: string; text: string }
  | { id: number; kind: "kick"; player: string; reason?: string; serverId?: string; env?: string };

type Registry = {
  servers: Map<string, ConnServer>;
  actions: ConnAction[];      // pending, polled by the proxy plugin(s)
  seq: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __conduitConnector: Registry | undefined;
}
// Seed the action sequence from the wall clock (ms). Action ids must stay MONOTONIC across panel
// restarts: the proxy plugin persists the last id it ran (ackActionId) and only executes actions
// with a higher id. A counter that reset to 0 on restart produced ids below the proxy's stale ack,
// so every new action was silently dropped — Date.now() always exceeds any prior run's ids.
if (!global.__conduitConnector) global.__conduitConnector = { servers: new Map(), actions: [], seq: Date.now() };
const reg = global.__conduitConnector;

const STALE_MS = 30_000; // a server unseen this long is considered offline

export function registerServer(s: Partial<ConnServer> & { id: string }) {
  const prev = reg.servers.get(s.id);
  reg.servers.set(s.id, {
    id: s.id,
    task: s.task ?? prev?.task ?? "",
    group: s.group ?? prev?.group ?? "",
    env: s.env ?? prev?.env ?? "server",
    node: s.node ?? prev?.node,
    ip: s.ip ?? prev?.ip,
    port: s.port ?? prev?.port,
    online: s.online ?? prev?.online ?? 0,
    max: s.max ?? prev?.max ?? 0,
    tps: s.tps ?? prev?.tps,
    players: s.players ?? prev?.players ?? [],
    lastSeen: Date.now(),
  });
}

export function heartbeat(id: string, data: Partial<ConnServer>) {
  const s = reg.servers.get(id);
  if (!s) { registerServer({ id, ...data }); return; }
  Object.assign(s, data, { lastSeen: Date.now() });
}

export function unregisterServer(id: string) { reg.servers.delete(id); }

/** All currently-live (non-stale) servers. */
export function liveServers(): ConnServer[] {
  const now = Date.now();
  return [...reg.servers.values()].filter((s) => now - s.lastSeen < STALE_MS);
}

/** Flattened player list across all backend servers (proxy duplicates filtered out).
 *  Dedup by UUID — distinct across platforms (an MC offline UUID ≠ a Hytale UUID), so a same-named
 *  MC + Hytale player correctly show as TWO rows; but the SAME player mid-switch between two MC
 *  backends shares one UUID → one row (most-recently-seen backend wins). Falls back to name+env
 *  only if a UUID is somehow missing. (Keying by name alone wrongly merged cross-platform
 *  same-name players and made the list flicker as heartbeats alternated.) */
export function allPlayers(): ConnPlayer[] {
  const out = new Map<string, { p: ConnPlayer; seen: number }>();
  for (const s of liveServers()) {
    if (s.env === "proxy") continue; // attribute players to their backend, not the proxy
    for (const p of s.players) {
      const key = p.uuid && p.uuid.length ? `u:${p.uuid}` : `n:${p.name.toLowerCase()}|${s.env}`;
      const prev = out.get(key);
      // server = task name (display); serverId = the specific instance, so a scaled task resolves
      // to the RIGHT vmid (was always mapping to the last instance sharing the task name).
      if (!prev || s.lastSeen > prev.seen) out.set(key, { p: { ...p, server: s.task, serverId: s.id }, seen: s.lastSeen });
    }
  }
  return [...out.values()].map((e) => e.p).sort((a, b) => a.name.localeCompare(b.name));
}

export function connectorActive(): boolean { return liveServers().length > 0; }

// Distribute Omit over the union so each variant keeps its own fields.
type ConnActionInput = ConnAction extends infer A ? (A extends { id: number } ? Omit<A, "id"> : never) : never;

/** Queue an action for the proxy plugin(s) to execute; returns its id. */
export function queueAction(a: ConnActionInput): number {
  const id = ++reg.seq;
  reg.actions.push({ ...a, id } as ConnAction);
  // keep the queue bounded
  if (reg.actions.length > 200) reg.actions.splice(0, reg.actions.length - 200);
  return id;
}

/** Drain actions newer than `sinceId` (the plugin tracks the last id it ran). Self-heals a
 *  sequence behind a proxy's persisted ack (after a panel restart / clock skew): bump our seq
 *  past the reported ack so subsequently-queued actions always exceed it and get delivered. */
export function drainActions(sinceId = 0): ConnAction[] {
  if (sinceId > reg.seq) reg.seq = sinceId;
  return reg.actions.filter((a) => a.id > sinceId);
}
