/**
 * Player audit log (ideas.md §11) — a per-player session/action trail: joins, quits, server
 * switches, and panel actions (kick/move/message/unqueue). Player-centric, deliberately light
 * (no world/block data), DSGVO-aware:
 *   - retention: day files older than network.auditRetentionDays are purged daily
 *   - right-to-erasure: erasePlayerAudit() rewrites all day files without that player
 *
 * Storage: one JSON array per day at audit/<YYYY-MM-DD>.json on the shared (GlusterFS) store,
 * via the node agent's fs API — same pattern as the Activity feed (in-memory buffer the leader
 * flushes periodically; per-event writes would hammer gluster).
 */
import { getDB } from "./store";

export type AuditType = "join" | "quit" | "switch" | "kick" | "move" | "message" | "unqueue";
export type AuditEntry = {
  at: number;
  type: AuditType;
  player: string;
  uuid?: string;
  /** server involved (joined/left/now-on); for `move` the destination */
  server?: string;
  /** free detail — kick reason, operator message text, … */
  detail?: string;
  /** who triggered it: the player themself or a panel operator action */
  actor?: "player" | "panel";
};

declare global {
  // eslint-disable-next-line no-var
  var __conduitAudit: { pending: AuditEntry[]; lastPurge: number } | undefined;
}
const buf = (global.__conduitAudit ??= { pending: [], lastPurge: 0 });

const DIR = "audit";
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Queue an audit entry (cheap, in-memory) — the leader's tick flushes to the store. */
export function recordAudit(e: Omit<AuditEntry, "at"> & { at?: number }) {
  buf.pending.push({ ...e, at: e.at ?? Date.now() });
  if (buf.pending.length > 5000) buf.pending.splice(0, buf.pending.length - 5000); // hard safety cap
}

async function readDay(day: string): Promise<AuditEntry[]> {
  try {
    const { fsRead } = await import("./agent");
    const { content } = await fsRead(`${DIR}/${day}.json`);
    const arr = JSON.parse(content);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Flush pending entries into their day files (append; read-modify-write per touched day). */
export async function flushAudit(): Promise<void> {
  if (!buf.pending.length) return;
  const batch = buf.pending.splice(0, buf.pending.length);
  try {
    const { fsWrite, fsMkdir } = await import("./agent");
    await fsMkdir(DIR).catch(() => {});
    const byDay = new Map<string, AuditEntry[]>();
    for (const e of batch) {
      const k = dayKey(e.at);
      const list = byDay.get(k) ?? [];
      list.push(e);
      byDay.set(k, list);
    }
    for (const [day, entries] of byDay) {
      const existing = await readDay(day);
      existing.push(...entries);
      if (existing.length > 50_000) existing.splice(0, existing.length - 50_000); // per-day cap
      await fsWrite(`${DIR}/${day}.json`, JSON.stringify(existing));
    }
  } catch {
    buf.pending.unshift(...batch); // store unreachable — retry next tick
    if (buf.pending.length > 5000) buf.pending.splice(0, buf.pending.length - 5000);
  }
}

/** Entries for the last `days`, optionally filtered by player name/uuid. Newest first. */
export async function queryAudit(player?: string, days = 7, limit = 500): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  const q = player?.trim().toLowerCase();
  const now = Date.now();
  // include today's unflushed buffer so the trail is live
  const sources: AuditEntry[][] = [buf.pending];
  for (let i = 0; i < Math.min(days, 90); i++) sources.push(await readDay(dayKey(now - i * 86_400_000)));
  for (const list of sources) {
    for (const e of list) {
      if (q && e.player.toLowerCase() !== q && e.uuid?.toLowerCase() !== q) continue;
      out.push(e);
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

/** Distinct day files currently stored. */
async function listDays(): Promise<string[]> {
  try {
    const { fsList } = await import("./agent");
    const { entries } = await fsList(DIR);
    return entries.filter((e) => e.name.endsWith(".json")).map((e) => e.name.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** Daily retention purge: delete day files older than network.auditRetentionDays (default 30). */
export async function purgeAudit(): Promise<void> {
  if (Date.now() - buf.lastPurge < 86_400_000) return;
  buf.lastPurge = Date.now();
  try {
    const db = await getDB();
    const keepDays = db.network?.auditRetentionDays ?? 30;
    const cutoff = dayKey(Date.now() - keepDays * 86_400_000);
    const days = await listDays();
    const stale = days.filter((d) => d < cutoff); // YYYY-MM-DD sorts lexicographically
    if (!stale.length) return;
    const { fsDelete } = await import("./agent");
    await fsDelete(stale.map((d) => `${DIR}/${d}.json`));
  } catch { /* retry tomorrow */ }
}

/** DSGVO right-to-erasure: strip a player (by name or uuid) from every stored day file. */
export async function erasePlayerAudit(nameOrUuid: string): Promise<{ removed: number }> {
  const q = nameOrUuid.trim().toLowerCase();
  if (!q) throw new Error("player required");
  let removed = 0;
  buf.pending = buf.pending.filter((e) => {
    const hit = e.player.toLowerCase() === q || e.uuid?.toLowerCase() === q;
    if (hit) removed++;
    return !hit;
  });
  const { fsWrite } = await import("./agent");
  for (const day of await listDays()) {
    const entries = await readDay(day);
    const kept = entries.filter((e) => !(e.player.toLowerCase() === q || e.uuid?.toLowerCase() === q));
    if (kept.length !== entries.length) {
      removed += entries.length - kept.length;
      await fsWrite(`${DIR}/${day}.json`, JSON.stringify(kept));
    }
  }
  return { removed };
}
