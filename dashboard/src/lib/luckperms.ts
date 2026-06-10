/**
 * LuckPerms link — the panel's connection to the network permission system.
 *
 * Storage is the Conduit-managed Postgres (pg-cluster, auto-discovered); messaging is the
 * Conduit Redis cluster, so an edit made anywhere (panel, in-game, other server) propagates
 * instantly. This module reads LuckPerms' tables directly for status + (later) the built-in
 * editor, and installs LuckPerms onto Paper/Velocity instances wired for that stack.
 */
import { Client } from "pg";
import { getPgCluster, pgPassword, PG_DB, PG_USER, PG_PORT } from "./pg-cluster";
import { getRedisCluster } from "./redis-cluster";

export type LpStatus = {
  connected: boolean;
  /** postgres primary "ip:port" (null = no postgres instance running) */
  host: string | null;
  /** schema initialized = LuckPerms booted at least once against this DB */
  initialized: boolean;
  groups: number;
  users: number;
  tracks: number;
  /** redis messaging endpoint LuckPerms syncs through (null = none live) */
  messaging: string | null;
  error?: string;
};

async function lpClient(): Promise<Client | null> {
  const pg = getPgCluster();
  if (!pg?.primary) return null;
  const client = new Client({
    host: pg.primary.ip,
    port: PG_PORT,
    user: PG_USER,
    password: await pgPassword(),
    database: PG_DB,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

/** Connection + schema health, read straight from the LuckPerms tables. */
export async function lpStatus(): Promise<LpStatus> {
  const pg = getPgCluster();
  const redis = getRedisCluster();
  const messaging = redis?.endpoints[0] ?? null;
  if (!pg?.primary) {
    return { connected: false, host: null, initialized: false, groups: 0, users: 0, tracks: 0, messaging, error: "no running PostgreSQL instance (deploy the PostgreSQL egg)" };
  }
  const host = `${pg.primary.ip}:${PG_PORT}`;
  let client: Client | null = null;
  try {
    client = await lpClient();
    if (!client) throw new Error("unreachable");
    const init = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'luckperms_groups' LIMIT 1`,
    );
    if (init.rowCount === 0) {
      return { connected: true, host, initialized: false, groups: 0, users: 0, tracks: 0, messaging };
    }
    const [g, u, t] = await Promise.all([
      client.query(`SELECT count(*)::int AS n FROM luckperms_groups`),
      client.query(`SELECT count(*)::int AS n FROM luckperms_players`),
      client.query(`SELECT count(*)::int AS n FROM luckperms_tracks`),
    ]);
    return {
      connected: true,
      host,
      initialized: true,
      groups: g.rows[0].n,
      users: u.rows[0].n,
      tracks: t.rows[0].n,
      messaging,
    };
  } catch (e) {
    return { connected: false, host, initialized: false, groups: 0, users: 0, tracks: 0, messaging, error: String(e) };
  } finally {
    await client?.end().catch(() => {});
  }
}

/** Resolve the latest LuckPerms build URLs per platform from the official metadata API. */
export async function lpDownloadUrls(): Promise<{ bukkit: string; velocity: string }> {
  const res = await fetch("https://metadata.luckperms.net/data/downloads", { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`luckperms metadata: HTTP ${res.status}`);
  const data = (await res.json()) as { downloads?: Record<string, string> };
  const bukkit = data.downloads?.bukkit;
  const velocity = data.downloads?.velocity;
  if (!bukkit || !velocity) throw new Error("luckperms metadata: missing bukkit/velocity download");
  return { bukkit, velocity };
}

/**
 * Install LuckPerms onto every running Paper/Velocity instance, wired to the shared
 * Postgres (storage) + Redis (messaging), then restart each so the plugin loads.
 * Idempotent — re-running refreshes jar + config. Returns per-instance results.
 */
export async function lpInstallAll(): Promise<{ vmid: number; name: string; ok: boolean; error?: string }[]> {
  const pg = getPgCluster();
  if (!pg?.primary) throw new Error("no running PostgreSQL instance — deploy the PostgreSQL egg first");
  const redis = getRedisCluster();
  const urls = await lpDownloadUrls();
  const pgPass = await pgPassword();

  const { getDB } = await import("./store");
  const { blueprint, loadBlueprints } = await import("./blueprints");
  const { discoverInstances, instancesOf } = await import("./engine");
  const { installLuckPerms, ctExec } = await import("./provision");
  const { nodeIp } = await import("./proxmox");

  await loadBlueprints();
  const db = await getDB();
  const all = await discoverInstances();
  const results: { vmid: number; name: string; ok: boolean; error?: string }[] = [];

  for (const t of db.tasks) {
    const kind = blueprint(t.blueprintId)?.software.kind;
    if (kind !== "paper" && kind !== "velocity") continue;
    for (const inst of instancesOf(all, t.id)) {
      if (inst.status !== "running" || !inst.ready) continue;
      try {
        const host = await nodeIp(inst.node);
        await installLuckPerms(inst.vmid, kind, {
          jarUrl: kind === "paper" ? urls.bukkit : urls.velocity,
          pgHost: pg.primary.ip,
          pgPassword: pgPass,
          redisAddr: redis?.endpoints[0] ?? null,
          redisPassword: redis?.password ?? "",
          serverName: inst.name,
        }, host);
        await ctExec(inst.vmid, `systemctl restart mc 2>/dev/null || true`, 30_000, host);
        results.push({ vmid: inst.vmid, name: inst.name, ok: true });
      } catch (e) {
        results.push({ vmid: inst.vmid, name: inst.name, ok: false, error: String(e) });
      }
    }
  }
  return results;
}
