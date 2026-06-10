/**
 * Panel-side world-sharding runtime: turns a sharded task's live instances into a strip grid,
 * serves each backend connector its grid + self-strip via the heartbeat config, and brokers
 * seamless transfers — when a player crosses a strip boundary the source connector reports it
 * here, we queue a proxy `move` to the owning instance and stash the player's exact coords so
 * the destination connector can teleport them on join (the Conduit-native CST equivalent).
 */
import { getDB, type Task } from "./store";
import { liveServers } from "./connector";
import { computeShardGrid, DEFAULT_SHARDING, type ShardGrid, type ShardMember } from "./sharding";
import { getRedisCluster } from "./redis-cluster";

/** velocity server name = sanitized task name + vmid (must match syncVelocity in provision.ts). */
function velocityName(taskName: string, vmid: number): string {
  return `${taskName.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}-${vmid}`;
}

/** trailing vmid from a connector id like "network-world-202". */
function vmidOf(id: string): number | null {
  const m = /-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** The ordered region members of a sharded task, from its currently-reporting instances. */
function membersForTask(t: Task): ShardMember[] {
  const out: ShardMember[] = [];
  for (const s of liveServers()) {
    if (s.env !== "server" || s.task !== t.name || s.group !== t.groupId) continue;
    const vmid = vmidOf(s.id);
    if (vmid == null) continue;
    out.push({ serverId: s.id, target: velocityName(t.name, vmid), name: s.id, vmid });
  }
  // strip assignment depends on a stable order → sort by vmid (oldest instance = center-ish).
  return out.sort((a, b) => a.vmid - b.vmid);
}

/**
 * The full strip grid for a task's live instances. Pure geometry — computed even when sharding
 * is disabled, so the UI can show a live PREVIEW of how the world would shard before you enable
 * it. The connector path (shardConfigForServer) separately gates on `enabled`, so a disabled
 * task is never actually told to shard.
 */
export function gridForTask(t: Task): ShardGrid | null {
  const members = membersForTask(t);
  if (members.length === 0) return null;
  return computeShardGrid(t.sharding ?? DEFAULT_SHARDING, members);
}

/* ---- pending transfers (player coords staged for the destination) ---------------------- */

type Pending = { player: string; loc: string; at: number };
declare global {
  // eslint-disable-next-line no-var
  var __conduitShardPending: Map<string, Map<string, Pending>> | undefined;
}
if (!global.__conduitShardPending) global.__conduitShardPending = new Map();
const pending = global.__conduitShardPending;
const PENDING_TTL = 30_000;

/** Stash a player's coords for the destination instance (keyed by its connector serverId). */
export function recordTransfer(targetServerId: string, player: string, loc: string) {
  let m = pending.get(targetServerId);
  if (!m) { m = new Map(); pending.set(targetServerId, m); }
  m.set(player.toLowerCase(), { player, loc, at: Date.now() });
}

/** Current (non-expired) pending coord-restores for a destination instance. */
export function pendingForServer(serverId: string): { player: string; loc: string }[] {
  return drainPending(serverId);
}

/** Drain (non-destructively; TTL-expires only) pending coord-restores for a destination. */
function drainPending(serverId: string): { player: string; loc: string }[] {
  const m = pending.get(serverId);
  if (!m) return [];
  const now = Date.now();
  const out: { player: string; loc: string }[] = [];
  for (const [k, p] of [...m.entries()]) {
    if (now - p.at > PENDING_TTL) { m.delete(k); continue; }
    out.push({ player: p.player, loc: p.loc });
  }
  return out;
}

/** Acknowledge applied restores so we don't re-send them. */
export function clearPending(serverId: string, players: string[]) {
  const m = pending.get(serverId);
  if (!m) return;
  for (const p of players) m.delete(p.toLowerCase());
}

/* ---- heartbeat config for a backend ---------------------------------------------------- */

export type ShardConfig = {
  self: string;                              // this instance's connector serverId
  grid: ShardGrid;
  pending: { player: string; loc: string }[]; // coord-restores to apply on join
  /** Redis endpoints (primary first) + auth for player-data sync; empty if no Redis is up. */
  redis?: { endpoints: string[]; password: string };
};

/** Build the sharding config block for a backend connector (null if its task isn't sharded). */
export async function shardConfigForServer(serverId: string, taskName: string, groupId: string): Promise<ShardConfig | null> {
  const db = await getDB();
  const task = db.tasks.find((t) => t.name === taskName && t.groupId === groupId)
    ?? db.tasks.find((t) => t.name === taskName);
  if (!task?.sharding?.enabled) return null;
  const grid = gridForTask(task);
  if (!grid) return null;
  // Only emit if THIS server is actually one of the regions (it registered & is in the grid).
  if (!grid.regions.some((r) => r.serverId === serverId)) return null;
  const rc = getRedisCluster();
  const redis = rc && rc.endpoints.length > 0 ? { endpoints: rc.endpoints, password: rc.password } : undefined;
  return { self: serverId, grid, pending: drainPending(serverId), redis };
}
