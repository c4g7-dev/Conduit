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

/* ───────────────────────── editor data layer ─────────────────────────
 * The built-in permissions editor reads/writes the LuckPerms tables directly
 * (same scheme the LP web editor applies via the plugin):
 *   luckperms_groups(name) · luckperms_players(uuid, username, primary_group)
 *   luckperms_{group,user}_permissions(name|uuid, permission, value, server, world, expiry, contexts)
 * Parents are `group.<name>` nodes; weight is `weight.<n>`; prefix/suffix are
 * `prefix.<weight>.<text>`. After any write, lpNetworkSync() runs `lp networksync`
 * on one live LP server — Redis messaging then refreshes every other instance.
 */

export type LpNode = {
  permission: string;
  value: boolean;
  server: string;   // 'global' = everywhere
  world: string;
  expiry: number;   // 0 = permanent (epoch seconds otherwise)
  contexts: string; // raw JSON
};

export type LpGroupSummary = {
  name: string;
  weight: number | null;
  prefix: string | null;
  parents: string[];
  nodeCount: number;
};

export type LpUserRow = { uuid: string; username: string | null; primaryGroup: string };

function parseNodes(rows: { permission: string; value: boolean; server: string; world: string; expiry: string | number; contexts: string }[]): LpNode[] {
  return rows.map((r) => ({
    permission: r.permission,
    value: r.value,
    server: r.server,
    world: r.world,
    expiry: Number(r.expiry) || 0,
    contexts: r.contexts ?? "{}",
  }));
}

const weightOf = (nodes: LpNode[]) => {
  const w = nodes.find((n) => n.permission.startsWith("weight.") && n.value);
  return w ? Number(w.permission.slice(7)) || null : null;
};
const prefixOf = (nodes: LpNode[]) => {
  const p = nodes.find((n) => n.permission.startsWith("prefix.") && n.value);
  return p ? p.permission.split(".").slice(2).join(".") : null;
};
const parentsOf = (nodes: LpNode[]) =>
  nodes.filter((n) => n.permission.startsWith("group.") && n.value).map((n) => n.permission.slice(6));

/** All groups with weight/prefix/parents summaries. */
export async function lpListGroups(): Promise<LpGroupSummary[]> {
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    const groups = await client.query(`SELECT name FROM luckperms_groups ORDER BY name`);
    const perms = await client.query(`SELECT name, permission, value, server, world, expiry, contexts FROM luckperms_group_permissions`);
    const byGroup = new Map<string, LpNode[]>();
    for (const r of perms.rows) {
      const list = byGroup.get(r.name) ?? [];
      list.push(...parseNodes([r]));
      byGroup.set(r.name, list);
    }
    return groups.rows.map((g: { name: string }) => {
      const nodes = byGroup.get(g.name) ?? [];
      return { name: g.name, weight: weightOf(nodes), prefix: prefixOf(nodes), parents: parentsOf(nodes), nodeCount: nodes.length };
    });
  } finally {
    await client.end().catch(() => {});
  }
}

/** A group's full node list. */
export async function lpGroupNodes(name: string): Promise<LpNode[]> {
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    const r = await client.query(
      `SELECT permission, value, server, world, expiry, contexts FROM luckperms_group_permissions WHERE name = $1 ORDER BY permission`,
      [name],
    );
    return parseNodes(r.rows);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Known players (joined at least once), filtered by name prefix. */
export async function lpListUsers(q = "", limit = 50): Promise<LpUserRow[]> {
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    const r = await client.query(
      `SELECT uuid, username, primary_group FROM luckperms_players
       WHERE username ILIKE $1 ORDER BY username LIMIT $2`,
      [`${q}%`, limit],
    );
    return r.rows.map((u: { uuid: string; username: string | null; primary_group: string }) => ({
      uuid: u.uuid, username: u.username, primaryGroup: u.primary_group,
    }));
  } finally {
    await client.end().catch(() => {});
  }
}

/** A user's node list + identity. */
export async function lpUserNodes(uuid: string): Promise<{ user: LpUserRow | null; nodes: LpNode[] }> {
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    const u = await client.query(`SELECT uuid, username, primary_group FROM luckperms_players WHERE uuid = $1`, [uuid]);
    const r = await client.query(
      `SELECT permission, value, server, world, expiry, contexts FROM luckperms_user_permissions WHERE uuid = $1 ORDER BY permission`,
      [uuid],
    );
    const row = u.rows[0];
    return {
      user: row ? { uuid: row.uuid, username: row.username, primaryGroup: row.primary_group } : null,
      nodes: parseNodes(r.rows),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export type LpTarget = { type: "group"; id: string } | { type: "user"; id: string };

const targetTable = (t: LpTarget) =>
  t.type === "group"
    ? { table: "luckperms_group_permissions", key: "name" }
    : { table: "luckperms_user_permissions", key: "uuid" };

/** Add (or upsert) a node on a group/user. */
export async function lpAddNode(t: LpTarget, node: Partial<LpNode> & { permission: string }): Promise<void> {
  const { table, key } = targetTable(t);
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    // LP has no unique constraint — delete an identical node first so we never duplicate.
    await client.query(
      `DELETE FROM ${table} WHERE ${key} = $1 AND permission = $2 AND server = $3 AND world = $4`,
      [t.id, node.permission, node.server ?? "global", node.world ?? "global"],
    );
    await client.query(
      `INSERT INTO ${table} (${key}, permission, value, server, world, expiry, contexts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [t.id, node.permission, node.value ?? true, node.server ?? "global", node.world ?? "global", node.expiry ?? 0, node.contexts ?? "{}"],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

/** Remove a node from a group/user (exact permission + context match). */
export async function lpRemoveNode(t: LpTarget, node: Partial<LpNode> & { permission: string }): Promise<void> {
  const { table, key } = targetTable(t);
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    await client.query(
      `DELETE FROM ${table} WHERE ${key} = $1 AND permission = $2 AND server = $3 AND world = $4`,
      [t.id, node.permission, node.server ?? "global", node.world ?? "global"],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

/** Create a group (no-op if it exists). */
export async function lpCreateGroup(name: string): Promise<void> {
  const n = name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!n) throw new Error("invalid group name");
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    await client.query(`INSERT INTO luckperms_groups (name) VALUES ($1) ON CONFLICT DO NOTHING`, [n]);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Delete a group + its nodes + any group.<name> parent references. */
export async function lpDeleteGroup(name: string): Promise<void> {
  if (name === "default") throw new Error("the default group cannot be deleted");
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    await client.query(`DELETE FROM luckperms_group_permissions WHERE name = $1`, [name]);
    await client.query(`DELETE FROM luckperms_groups WHERE name = $1`, [name]);
    await client.query(`DELETE FROM luckperms_group_permissions WHERE permission = $1`, [`group.${name}`]);
    await client.query(`DELETE FROM luckperms_user_permissions WHERE permission = $1`, [`group.${name}`]);
  } finally {
    await client.end().catch(() => {});
  }
}

/* ---- known permissions (editor autocomplete) ----
 * LuckPerms' editor offers completion from the permissions it has seen. We combine:
 * every distinct permission already stored (groups + users), a curated catalog of
 * common proxy/server/LP/Conduit nodes, and conduit.maintenance.bypass.<task> for
 * each live task — so the bypass nodes for YOUR network complete out of the box. */

const PERM_CATALOG = [
  // Conduit
  "conduit.admin", "conduit.maintenance.bypass", "conduit.queue.priority",
  // LuckPerms
  "luckperms.*", "luckperms.user.info", "luckperms.user.perm.set", "luckperms.user.perm.unset",
  "luckperms.user.parent.add", "luckperms.user.parent.remove", "luckperms.user.promote", "luckperms.user.demote",
  "luckperms.group.info", "luckperms.group.perm.set", "luckperms.group.perm.unset",
  "luckperms.creategroup", "luckperms.deletegroup", "luckperms.listgroups", "luckperms.editor", "luckperms.sync",
  // Velocity (proxy)
  "velocity.command.server", "velocity.command.glist", "velocity.command.send",
  "velocity.command.shutdown", "velocity.command.velocity", "velocity.command.plugins",
  // Minecraft / Bukkit commands
  "minecraft.command.gamemode", "minecraft.command.teleport", "minecraft.command.tp", "minecraft.command.give",
  "minecraft.command.kick", "minecraft.command.ban", "minecraft.command.pardon", "minecraft.command.op",
  "minecraft.command.whitelist", "minecraft.command.time", "minecraft.command.weather", "minecraft.command.difficulty",
  "minecraft.command.say", "minecraft.command.stop", "minecraft.command.kill", "minecraft.command.effect",
  "minecraft.command.enchant", "minecraft.command.xp", "minecraft.command.summon", "minecraft.command.clear",
  "minecraft.command.fill", "minecraft.command.setblock", "minecraft.command.setworldspawn", "minecraft.command.spawnpoint",
  "bukkit.command.version", "bukkit.command.plugins", "bukkit.command.reload", "bukkit.command.restart",
  "bukkit.command.timings", "bukkit.command.help",
];

/** Distinct known permissions for autocomplete: stored nodes + catalog + per-task bypass nodes. */
export async function lpKnownPermissions(): Promise<string[]> {
  const out = new Set<string>(PERM_CATALOG);
  try {
    const { getDB } = await import("./store");
    const db = await getDB();
    for (const t of db.tasks) out.add(`conduit.maintenance.bypass.${t.name}`);
  } catch { /* store unreachable — catalog only */ }
  const client = await lpClient().catch(() => null);
  if (client) {
    try {
      const [g, u] = await Promise.all([
        client.query(`SELECT DISTINCT permission FROM luckperms_group_permissions`),
        client.query(`SELECT DISTINCT permission FROM luckperms_user_permissions`),
      ]);
      for (const r of [...g.rows, ...u.rows]) {
        const p = r.permission as string;
        // structured nodes (group./prefix./weight.) aren't useful as raw permission completions
        if (!/^(group|prefix|suffix|weight|displayname)\./.test(p)) out.add(p);
      }
    } catch { /* schema not initialized yet */ } finally {
      await client.end().catch(() => {});
    }
  }
  return [...out].sort();
}

/* ---- tracks (promotion ladders) ---- */

export type LpTrack = { name: string; groups: string[] };

export async function lpListTracks(): Promise<LpTrack[]> {
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    const r = await client.query(`SELECT name, groups FROM luckperms_tracks ORDER BY name`);
    return r.rows.map((t: { name: string; groups: string }) => {
      let groups: string[] = [];
      try { groups = JSON.parse(t.groups); } catch { /* empty */ }
      return { name: t.name, groups };
    });
  } finally {
    await client.end().catch(() => {});
  }
}

/** Create a track or replace its group ladder (ordered low → high). */
export async function lpSaveTrack(name: string, groups: string[]): Promise<void> {
  const n = name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!n) throw new Error("invalid track name");
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    // manual upsert — LP's tracks table has no unique constraint on some schema versions
    const upd = await client.query(`UPDATE luckperms_tracks SET groups = $2 WHERE name = $1`, [n, JSON.stringify(groups)]);
    if (upd.rowCount === 0) {
      await client.query(`INSERT INTO luckperms_tracks (name, groups) VALUES ($1, $2)`, [n, JSON.stringify(groups)]);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

export async function lpDeleteTrack(name: string): Promise<void> {
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    await client.query(`DELETE FROM luckperms_tracks WHERE name = $1`, [name]);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Set a user's primary group (lp user <x> parent switchprimarygroup equivalent). */
export async function lpSetPrimaryGroup(uuid: string, group: string): Promise<void> {
  const client = await lpClient();
  if (!client) throw new Error("postgres unreachable");
  try {
    await client.query(`UPDATE luckperms_players SET primary_group = $2 WHERE uuid = $1`, [uuid, group]);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Push panel edits to the live network: run `lp networksync` on one running LP server —
 * it re-syncs from the DB and broadcasts an update over Redis messaging, refreshing every
 * other instance. Fire-and-forget from mutation routes.
 */
export async function lpNetworkSync(): Promise<boolean> {
  const { getDB } = await import("./store");
  const { blueprint, loadBlueprints } = await import("./blueprints");
  const { discoverInstances, instancesOf } = await import("./engine");
  const { sendKeys } = await import("./ops");
  await loadBlueprints();
  const db = await getDB();
  const all = await discoverInstances();
  for (const t of db.tasks) {
    if (blueprint(t.blueprintId)?.software.kind !== "paper") continue;
    for (const inst of instancesOf(all, t.id)) {
      if (inst.status !== "running" || !inst.ready) continue;
      try {
        await sendKeys(inst.vmid, "lp networksync");
        return true;
      } catch { /* try the next instance */ }
    }
  }
  return false;
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
