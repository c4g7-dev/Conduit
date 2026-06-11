/**
 * conduitd — the Conduit controller's reconcile engine.
 *
 * Drives Proxmox reality towards the desired state in the store: for each task,
 * ensure `desired` live LXC instances exist, provisioned from its blueprint,
 * tagged so we can find them again. Collects each instance's IP from the Proxmox
 * interfaces API and builds proxy -> backend routing tables.
 *
 * SAFETY: only ever touches containers tagged `conduit` in VMID range 200-999.
 * Hand-made containers (e.g. CT100) are never read as instances nor destroyed.
 */
import { api, lxcIp, waitTask, nodeIp, NODE } from "./proxmox";
import { blueprint, loadBlueprints, type Blueprint, type Seed } from "./blueprints";
import { getDB, getNetwork, mutate, type Task, type Group, type ImageStatus } from "./store";
import {
  installPaper,
  installVelocity,
  installHytale,
  installNginx,
  installRedis,
  setRedisReplication,
  installPostgres,
  installLimbo,
  installConnector,
  installHytaleConnector,
  installGenericCustom,
  regenWorldWithSeed,
  syncVelocity,
  forgetVelocity,
  nodeExec,
  pushInstallLog,
  ctExec,
  type ProxyServer,
} from "./provision";
import { connServersByVmid } from "./metrics-source";
import { allPlayers } from "./connector";
import { recordMetrics } from "./metrics-history";
import { imageFor, cloneInstance, clonePrepared, promotePrepared, PREPARED_TAG } from "./images";
import { applyTemplate, serviceDir } from "./templates";
import { ensureServiceShare } from "./serviceshare";
import { syncTaskFiles } from "./taskfile";
import { assetNodePath } from "./assets";
import { recordReconcile } from "./events";
import { redisPassword, setRedisCluster, REDIS_PORT } from "./redis-cluster";
import { pgPassword, setPgCluster } from "./pg-cluster";

export const CONDUIT_TAG = "conduit";
export const READY_TAG = "ready";
const VMID_FROM = 200;
const VMID_TO = 999;
// Host dir bind-mounted read-only into every instance at /assets (shared asset store).
const ASSETS_DIR = process.env.CONDUIT_ASSETS_DIR ?? "";

export type Instance = {
  vmid: number;
  name: string;
  node: string;
  status: string;
  taskId: string;
  ip: string | null;
  /** raw Proxmox tag string, kept so we can append the `ready` marker */
  tags: string;
  /** software provisioned (Paper/Velocity installed) */
  ready: boolean;
};

const taskTag = (id: string) => `t-${id}`;
const groupTag = (id: string) => `g-${id}`;
function parseTags(tags?: string): string[] {
  return (tags ?? "").split(/[;,]/).map((t) => t.trim()).filter(Boolean);
}

// Controller runtime state. CRITICAL: this lives on `global` so it is shared across Next.js
// module instances — route handlers and the instrumentation loop can load engine.ts in SEPARATE
// instances (see store.ts), and a module-local reconcile lock / in-flight set is NOT shared
// between them. That let two reconciles run concurrently (e.g. a POST /api/tasks reconcile + the
// periodic loop), each seeing have=0 for desired=1 and BOTH provisioning → an extra instance.
// One global keeps the lock + dedup authoritative process-wide.
type ControllerState = {
  recent: Map<string, Map<number, number>>; // taskId -> vmid -> ts (in-flight creates)
  provisioning: Set<number>;                // vmids whose software install is running
  lastSpawn: Map<string, number>;           // taskId -> ts of last provision (spawn cooldown)
  emptySince: Map<number, number>;          // vmid -> ts it first appeared empty (idle drain)
  busy: boolean;                            // reconcile in progress (single-flight lock)
  restores: number;                         // active restores (pause reconcile)
};
declare global {
  // eslint-disable-next-line no-var
  var __conduitController: ControllerState | undefined;
}
const ctl: ControllerState = global.__conduitController ??= {
  recent: new Map(), provisioning: new Set(), lastSpawn: new Map(), emptySince: new Map(),
  busy: false, restores: 0,
};
const recent = ctl.recent;
const provisioning = ctl.provisioning;
const lastSpawn = ctl.lastSpawn;
const emptySince = ctl.emptySince;

// Containers we just asked Proxmox to create — cluster/resources lags ~10s, so
// remember them briefly to avoid double-provisioning on the next tick.
function noteCreate(taskId: string, vmid: number) {
  if (!recent.has(taskId)) recent.set(taskId, new Map());
  recent.get(taskId)!.set(vmid, Date.now());
}
/** Drop a vmid from the in-flight set — e.g. a provision that failed, so it never counts
 *  toward `have` (a phantom pending instance inflated `have` and triggered bad scale-downs). */
function noteForget(taskId: string, vmid: number) {
  recent.get(taskId)?.delete(vmid);
}
function recentVmids(taskId: string): number[] {
  const m = recent.get(taskId);
  if (!m) return [];
  const now = Date.now();
  // 180s window — a clone/boot + cluster-cache lag can exceed 90s; expiring too early made
  // the autoscaler re-provision a still-starting instance (runaway).
  for (const [vmid, ts] of m) if (now - ts > 180_000) m.delete(vmid);
  return [...m.keys()];
}

// While a restore is in flight the target CT is stopped/replaced; pause reconcile
// so the controller doesn't mistake it for a missing instance and spawn a duplicate.
export function beginRestore() {
  ctl.restores++;
}
export function endRestore() {
  ctl.restores = Math.max(0, ctl.restores - 1);
}

/** Install the role's MC software inside a running instance, then tag it ready. */
async function provisionInstance(inst: Instance, task: Task, bp: Blueprint) {
  const net = await getNetwork();
  const version = task.software?.version ?? bp.software.version;
  const host = await nodeIp(inst.node);
  const kind = bp.software.kind;

  // remember the upstream build that landed, so version tracking can flag hotfixes
  const noteBuild = async (b: number) => {
    if (!b) return;
    await mutate((d) => {
      const x = d.tasks.find((y) => y.id === task.id);
      if (x && (!x.installedBuild || b > x.installedBuild)) x.installedBuild = b;
    }).catch(() => {});
  };

  if (kind === "velocity") {
    await noteBuild(await installVelocity(inst.vmid, task, net.forwardingSecret, version, host));
  } else if (kind === "paper") {
    const merged = {
      ...bp.seed,
      ...task.seed,
      properties: { ...bp.seed?.properties, ...task.seed?.properties },
      plugins: [...(bp.seed?.plugins ?? []), ...(task.seed?.plugins ?? [])],
    };
    const seed = await resolveSeedAssets(inst, merged);
    await noteBuild(await installPaper(inst.vmid, task, net.forwardingSecret, seed, version, host));
  } else if (kind === "hytale") {
    // Hytale uses the shared /assets mount (sharedAssets: true on the blueprint).
    // ensureHytaleAssets runs first: auto-downloads the binary when downloadUrl is set,
    // or warns + waits if it's missing and no URL is configured.
    const sw = { ...bp.software, ...task.software };
    await installHytale(inst.vmid, task, sw, host);
  } else if (kind === "mariadb") {
    pushInstallLog(inst.vmid, `[conduit] MariaDB install recipe not yet implemented — container is a bare OS.`);
    await ctExec(inst.vmid, `echo "[conduit] MariaDB placeholder." > /opt/conduit-info.txt`, 30_000, host);
  } else if (kind === "nginx") {
    await installNginx(inst.vmid, host);
  } else if (kind === "redis") {
    await installRedis(inst.vmid, await redisPassword(), host);
  } else if (kind === "postgres") {
    await installPostgres(inst.vmid, await pgPassword(), host);
  } else if (kind === "limbo") {
    await installLimbo(inst.vmid, task, net.forwardingSecret, host);
  } else {
    // generic — run the custom provisioning recipe (packages/assets/install/start) if defined,
    // else come up as a bare container.
    if (bp.custom) pushInstallLog(inst.vmid, `[conduit] "${bp.name}" — running custom recipe (assets/install/start)…`);
    else pushInstallLog(inst.vmid, `[conduit] Blueprint "${bp.name}" (${kind}) — bare container (no custom recipe).`);
    await installGenericCustom(inst.vmid, bp, host);
  }

  // CloudNet-style overlay: egg + _global/<kind> + named templates + task → service dir.
  try {
    const db = await getDB();
    const tplIds = (db.globalTemplates ?? []).filter((t) => t.taskIds.includes(task.id)).map((t) => t.id);
    await applyTemplate(inst.vmid, bp.id, task.id, serviceDir(kind), host, kind, tplIds);
  } catch (e) {
    pushInstallLog(inst.vmid, `[conduit] file overlay skipped: ${String(e)}`);
  }

  // Bind the service's config/plugins onto the shared store (SFTP/file-manager editable).
  try {
    await ensureServiceShare(inst.vmid, kind, host);
  } catch (e) {
    pushInstallLog(inst.vmid, `[conduit] service share skipped: ${String(e)}`);
  }

  // Install the Conduit connector plugin into Paper/Velocity (CloudNet-Bridge equivalent).
  // The jar lands AFTER installPaper/Velocity already booted the server and scanned plugins,
  // so it must be restarted for the plugin to actually load (otherwise the instance runs
  // without the connector → shows 0/0, no green dot, and can't shard). Velocity is restarted
  // anyway by syncVelocity on the next routing pass; Paper backends need an explicit restart.
  if (kind === "paper" || kind === "velocity") {
    try {
      await installConnector(inst.vmid, host);
      if (kind === "paper") await ctExec(inst.vmid, `systemctl restart mc 2>/dev/null || true`, 30_000, host);
    } catch (e) {
      pushInstallLog(inst.vmid, `[conduit] connector install skipped: ${String(e)}`);
    }
  } else if (kind === "hytale") {
    // Hytale gets its own connector mod (reports players to the panel like the MC connector).
    try {
      await installHytaleConnector(inst.vmid, host);
      await ctExec(inst.vmid, `systemctl restart mc 2>/dev/null || true`, 30_000, host);
    } catch (e) {
      pushInstallLog(inst.vmid, `[conduit] hytale connector install skipped: ${String(e)}`);
    }
  }

  const tags = inst.tags ? `${inst.tags};${READY_TAG}` : READY_TAG;
  await api.setLxcConfig(inst.vmid, { tags }, inst.node);
}

/**
 * Push any `conduit-asset:` seed references into the container (via `pct push` on the
 * node) and rewrite them to the in-container path, so seedShell can cp/extract them.
 * Lets uploaded worlds/plugins reach MC containers without the read-only /assets mount.
 */
async function resolveSeedAssets(inst: Instance, seed: Seed): Promise<Seed> {
  const host = await nodeIp(inst.node);
  const homeHost = await nodeIp(NODE); // where assets are uploaded
  const pushOne = async (ref: string): Promise<string> => {
    const nodePath = assetNodePath(ref);
    if (!nodePath) return ref; // a plain URL or local path — leave as-is
    const base = nodePath.split("/").pop()!;
    const dest = `/opt/conduit-seed/${base}`;
    // if the CT's node doesn't have the asset (it lives on the home node), pull it
    // across the cluster's inter-node SSH first.
    const dir = nodePath.slice(0, nodePath.lastIndexOf("/"));
    const ensure =
      host === homeHost
        ? ""
        : `mkdir -p '${dir}'; [ -f '${nodePath}' ] || scp -o StrictHostKeyChecking=no -o BatchMode=yes root@${homeHost}:'${nodePath}' '${nodePath}'; `;
    await nodeExec(
      `${ensure}pct exec ${inst.vmid} -- mkdir -p /opt/conduit-seed && pct push ${inst.vmid} '${nodePath}' '${dest}'`,
      120_000,
      host,
    );
    return dest;
  };
  const out: Seed = { ...seed };
  if (seed.worldUrl) out.worldUrl = await pushOne(seed.worldUrl);
  if (seed.icon) out.icon = await pushOne(seed.icon);
  if (seed.plugins?.length) out.plugins = await Promise.all(seed.plugins.map(pushOne));
  return out;
}

/** Kick background software installs for any running, un-provisioned instance. */
function provisionPass(db: Awaited<ReturnType<typeof getDB>>, all: Instance[], log: string[]) {
  for (const inst of all) {
    if (inst.status !== "running" || !inst.ip || inst.ready) continue;
    if (provisioning.has(inst.vmid)) continue;
    const task = db.tasks.find((t) => t.id === inst.taskId);
    const bp = task ? blueprint(task.blueprintId) : undefined;
    if (!task || !bp) continue;

    provisioning.add(inst.vmid);
    log.push(`~ ${task.id}: installing ${bp.role} on ${inst.vmid}`);
    provisionInstance(inst, task, bp)
      .then(() => console.log(`[conduitd] provisioned ${bp.role} on ${inst.vmid}`))
      .catch((e) => console.error(`[conduitd] provision ${inst.vmid} failed:`, String(e)))
      .finally(() => provisioning.delete(inst.vmid));
  }
}

/** Render each ready proxy's velocity.toml from its ready backends; restart on change. */
async function velocityPass(
  db: Awaited<ReturnType<typeof getDB>>,
  all: Instance[],
  log: string[],
) {
  const proxies = db.tasks.filter((t) => blueprint(t.blueprintId)?.role === "proxy");
  for (const proxy of proxies) {
    const ready = (i: Instance) => i.status === "running" && !!i.ip && i.ready;
    const servers: ProxyServer[] = proxy.fronts.flatMap((fid) => {
      const ft = db.tasks.find((t) => t.id === fid);
      const fbp = ft ? blueprint(ft.blueprintId) : undefined;
      if (!ft || !fbp) return [];
      return instancesOf(all, fid)
        .filter(ready)
        .map((i) => ({
          name: `${ft.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}-${i.vmid}`,
          ip: i.ip!,
          port: fbp.port,
        }));
    });
    // Always push velocity.toml to every ready proxy — even with zero backends.
    // Without this, a fresh proxy runs with Velocity's auto-generated placeholder config
    // (lobby = "127.0.0.1:30066", etc.) which causes connection failures until backends
    // arrive. An empty servers list produces a valid toml that Velocity accepts cleanly.

    for (const p of instancesOf(all, proxy.id).filter(ready)) {
      try {
        const host = await nodeIp(p.node);
        if (await syncVelocity(p.vmid, proxy, servers, host))
          log.push(`= ${proxy.id}: routed ${servers.length} backend(s) → velocity ${p.vmid}`);
      } catch (e) {
        log.push(`! velocity sync ${p.vmid}: ${String(e)}`);
      }
    }
  }
}

// Track the last applied redis membership so we only re-issue replicaof on change.
declare global { var __conduitRedisSig: string | undefined; }

/**
 * Designate a Redis cluster from the running redis-kind instances (lowest vmid = primary, rest
 * replicate it) and publish the endpoint list for connectors. Re-wires replication only when
 * membership changes; failover is the connector trying the published list in order.
 */
async function redisPass(
  db: Awaited<ReturnType<typeof getDB>>,
  all: Instance[],
  log: string[],
) {
  const redisTasks = db.tasks.filter((t) => blueprint(t.blueprintId)?.software.kind === "redis");
  if (redisTasks.length === 0) { setRedisCluster({ primary: null, endpoints: [], password: "", updatedAt: Date.now() }); return; }
  const insts = redisTasks
    .flatMap((t) => instancesOf(all, t.id))
    .filter((i) => i.status === "running" && !!i.ip && i.ready)
    .sort((a, b) => a.vmid - b.vmid);
  const pw = await redisPassword();
  if (insts.length === 0) { setRedisCluster({ primary: null, endpoints: [], password: pw, updatedAt: Date.now() }); return; }

  const primary = insts[0];
  setRedisCluster({
    primary: { vmid: primary.vmid, ip: primary.ip! },
    endpoints: insts.map((i) => `${i.ip}:${REDIS_PORT}`),
    password: pw,
    updatedAt: Date.now(),
  });

  const sig = insts.map((i) => `${i.vmid}@${i.ip}`).join(",") + `|p=${primary.vmid}`;
  if (global.__conduitRedisSig === sig) return;
  for (const i of insts) {
    try {
      const host = await nodeIp(i.node);
      await setRedisReplication(i.vmid, pw, i.vmid === primary.vmid ? null : primary.ip!, host);
    } catch (e) {
      log.push(`! redis replication ${i.vmid}: ${String(e)}`);
      return; // leave sig unset so we retry next pass
    }
  }
  global.__conduitRedisSig = sig;
  log.push(`= redis: primary ${primary.vmid} (${primary.ip}), ${insts.length - 1} replica(s)`);
}

/**
 * Publish the Postgres primary (lowest-vmid running postgres-kind instance) for the
 * LuckPerms storage link — read by the panel's LuckPerms client and the LP installer.
 */
async function pgPass(db: Awaited<ReturnType<typeof getDB>>, all: Instance[]) {
  const pgTasks = db.tasks.filter((t) => blueprint(t.blueprintId)?.software.kind === "postgres");
  const insts = pgTasks
    .flatMap((t) => instancesOf(all, t.id))
    .filter((i) => i.status === "running" && !!i.ip && i.ready)
    .sort((a, b) => a.vmid - b.vmid);
  setPgCluster({
    primary: insts[0] ? { vmid: insts[0].vmid, ip: insts[0].ip! } : null,
    updatedAt: Date.now(),
  });
}

/**
 * Auto-hotfix (ideas.md §1): for tasks with autoUpdate on, apply newer BUILDS of the pinned
 * version line. Only instances with 0 players are touched (a hotfix restart never kicks
 * anyone); occupied ones retry next pass. Full version upgrades are NEVER automatic.
 * Throttled to one upstream check per 10 min.
 */
async function autoUpdatePass(
  db: Awaited<ReturnType<typeof getDB>>,
  all: Instance[],
  log: string[],
) {
  const g = global as unknown as { __conduitAutoUpdAt?: number };
  if (Date.now() - (g.__conduitAutoUpdAt ?? 0) < 600_000) return;
  g.__conduitAutoUpdAt = Date.now();

  const { jarFor, effectiveVersion } = await import("./version-status");
  const { applyJarUpdate } = await import("./provision");
  const byVmidPlayers = connServersByVmid();

  for (const t of db.tasks) {
    if (!t.autoUpdate) continue;
    const { kind, version } = effectiveVersion(t);
    if (kind !== "paper" && kind !== "velocity") continue;
    try {
      const jar = await jarFor(kind, version);
      if (!t.installedBuild || jar.build <= t.installedBuild) continue;
      let allDone = true;
      for (const inst of instancesOf(all, t.id)) {
        if (inst.status !== "running" || !inst.ready) continue;
        const players = byVmidPlayers.get(inst.vmid)?.online ?? 0;
        if (players > 0) { allDone = false; continue; } // never kick players for a hotfix
        await applyJarUpdate(inst.vmid, kind, jar.jarUrl, await nodeIp(inst.node));
        log.push(`^ hotfix ${t.name} #${inst.vmid}: ${kind} ${version} build ${t.installedBuild} → ${jar.build}`);
      }
      if (allDone) {
        await mutate((d) => { const x = d.tasks.find((y) => y.id === t.id); if (x) x.installedBuild = jar.build; });
      }
    } catch (e) {
      log.push(`! hotfix ${t.name}: ${String(e)}`);
    }
  }
}

/** Named global templates that include this task. */
function tplIdsFor(db: Awaited<ReturnType<typeof getDB>>, taskId: string): string[] {
  return (db.globalTemplates ?? []).filter((t) => t.taskIds.includes(taskId)).map((t) => t.id);
}

/** Re-apply a task's overlay chain to its running instances (+ optionally restart) —
 *  instances in parallel (the serial version made multi-instance resyncs feel stuck).
 *  Progress (per-instance status, total bytes/files) is published to the sync-status registry
 *  so the UI can show what's copying where with size + ETA. */
export async function resyncTaskFiles(taskId: string, restart = true, trigger: "manual" | "auto" = "manual"): Promise<{ vmid: number; ok: boolean; error?: string }[]> {
  await loadBlueprints();
  const db = await getDB();
  const t = db.tasks.find((x) => x.id === taskId);
  const bp = t && blueprint(t.blueprintId);
  if (!t || !bp) throw new Error("task not found");
  const kind = bp.software.kind;
  const tplIds = tplIdsFor(db, t.id);
  const all = await discoverInstances();
  const targets = instancesOf(all, t.id).filter((i) => i.status === "running" && i.ready);

  const { startSync, updateSyncInstance, finishSync } = await import("./sync-status");
  const { overlaySize } = await import("./templates");
  const size = await overlaySize(bp.id, t.id, kind, await nodeIp(targets[0]?.node ?? NODE), tplIds).catch(() => ({ bytes: 0, files: 0 }));
  const syncId = startSync({
    taskId: t.id, taskName: t.name, trigger, restart,
    bytes: size.bytes, files: size.files,
    instances: targets.map((i) => ({ vmid: i.vmid, node: i.node, status: "pending" as const })),
  });

  const results = await Promise.all(targets.map(async (inst): Promise<{ vmid: number; ok: boolean; error?: string }> => {
    updateSyncInstance(syncId, inst.vmid, { status: "copying", startedAt: Date.now() });
    try {
      const host = await nodeIp(inst.node);
      await applyTemplate(inst.vmid, bp.id, t.id, serviceDir(kind), host, kind, tplIds);
      if (restart) await ctExec(inst.vmid, `systemctl restart mc 2>/dev/null || true`, 30_000, host);
      updateSyncInstance(syncId, inst.vmid, { status: "done", finishedAt: Date.now() });
      return { vmid: inst.vmid, ok: true };
    } catch (e) {
      updateSyncInstance(syncId, inst.vmid, { status: "error", error: String(e), finishedAt: Date.now() });
      return { vmid: inst.vmid, ok: false, error: String(e) };
    }
  }));
  finishSync(syncId);
  return results;
}

/**
 * Rewrite-on-change (ideas.md §2): for templateSync tasks, watch the overlay chain's signature;
 * when an edit lands (file manager/SFTP on the shared store), re-apply the files — and restart
 * the instances only if templateSyncRestart is set (else changes load on the next natural
 * restart, never kicking players).
 * - signatures for ALL watched tasks are fetched in ONE ssh call (overlaySignatures)
 * - the last-applied signature is PERSISTED on the task, so a panel restart can't silently
 *   absorb an overlay edit as a fresh baseline (the old in-memory map did exactly that)
 * - scans every ~15s (was 60s — felt like "nothing happens")
 */
async function templateSyncPass(
  db: Awaited<ReturnType<typeof getDB>>,
  log: string[],
) {
  const g = global as unknown as { __conduitTplAt?: number };
  if (Date.now() - (g.__conduitTplAt ?? 0) < 15_000) return;
  g.__conduitTplAt = Date.now();

  const watched = db.tasks.filter((t) => t.templateSync && blueprint(t.blueprintId));
  if (!watched.length) return;

  const { overlaySignatures } = await import("./templates");
  let sigs: Map<string, string>;
  try {
    sigs = await overlaySignatures(watched.map((t) => ({
      taskId: t.id,
      eggId: blueprint(t.blueprintId)!.id,
      kind: blueprint(t.blueprintId)!.software.kind,
      tplIds: tplIdsFor(db, t.id),
    })));
  } catch (e) {
    log.push(`! template sync scan: ${String(e)}`);
    return;
  }

  for (const t of watched) {
    const sig = sigs.get(t.id);
    if (sig === undefined) continue;
    const prev = t.templateSyncSig;
    if (prev === sig) continue;
    // persist FIRST so a crash mid-apply doesn't re-trigger forever; first sighting arms only
    await mutate((d) => {
      const x = d.tasks.find((y) => y.id === t.id);
      if (x) x.templateSyncSig = sig;
    }).catch(() => {});
    if (prev === undefined) continue; // baseline armed (survives restarts from now on)
    try {
      const res = await resyncTaskFiles(t.id, t.templateSyncRestart === true, "auto");
      log.push(`~ template sync ${t.name}: overlay changed → re-applied to ${res.filter((r) => r.ok).length} instance(s)${t.templateSyncRestart ? " + restart" : " (no restart)"}`);
    } catch (e) {
      log.push(`! template sync ${t.name}: ${String(e)}`);
    }
  }
}

/** All Conduit-managed containers grouped by task, with live IPs. */
export async function discoverInstances(): Promise<Instance[]> {
  const res = await api.clusterResources();
  const cts = res.filter(
    (r) =>
      r.type === "lxc" &&
      r.vmid != null &&
      r.vmid >= VMID_FROM &&
      r.vmid <= VMID_TO &&
      parseTags(r.tags).includes(CONDUIT_TAG),
  );

  // resolve IPs in parallel — sequential awaits here were the main page-load cost
  return Promise.all(
    cts.map(async (c) => {
      const tags = parseTags(c.tags);
      const tTag = tags.find((t) => t.startsWith("t-"));
      return {
        vmid: c.vmid!,
        name: c.name ?? `ct-${c.vmid}`,
        node: c.node ?? NODE,
        status: c.status ?? "unknown",
        taskId: tTag ? tTag.slice(2) : "",
        ip: c.status === "running" ? await lxcIp(c.vmid!, c.node ?? NODE) : null,
        tags: c.tags ?? "",
        ready: tags.includes(READY_TAG),
      };
    }),
  );
}

export function instancesOf(all: Instance[], taskId: string): Instance[] {
  return all.filter((i) => i.taskId === taskId);
}

/** Live online-player count per vmid via SLP (best-effort; unreachable → absent). */
/** Live player counts per instance, from the connector registry (SLP is gone). Instances
 *  not yet reporting are simply absent (treated as 0 by callers). */
function playerCounts(insts: Instance[]): Map<number, number> {
  const conn = connServersByVmid();
  const out = new Map<number, number>();
  for (const i of insts) {
    const s = conn.get(i.vmid);
    if (s) out.set(i.vmid, s.online);
  }
  return out;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));

/**
 * Autoscale target for a dynamic task (CloudNet Smart-style). Scale up a spare once any
 * server would exceed `scaleUpPercent` of capacity; keep `min` as the always-on floor; cap
 * at `max`/`maxServices`. Percent defaults to 100 (= "one spare above full").
 */
export function autoscaleTarget(
  players: number, perInstance: number, min: number, max: number, scaleUpPercent = 100,
) {
  const per = Math.max(1, perInstance);
  const threshold = Math.max(1, Math.floor((per * Math.max(1, scaleUpPercent)) / 100));
  // how many servers are needed so none exceeds the scale-up threshold
  const needed = Math.ceil(players / threshold);
  const spare = needed > min ? 1 : 0; // a spare joinable server above the floor
  const loadBased = Math.max(min, needed + spare);
  const cap = max > 0 ? max : loadBased;
  return clamp(loadBased, min, cap);
}

async function ensurePool(group: Group) {
  const pools = await api.pools().catch(() => []);
  if (!pools.some((p) => p.poolid === group.id)) {
    await api.createPool(group.id, `Conduit group: ${group.name}`).catch(() => {});
  }
}

/** Use a pinned node when it's set and currently online; otherwise auto-pick. */
async function resolveNode(pinned?: string): Promise<string> {
  if (pinned) {
    const nodes = await api.nodes().catch(() => []);
    if (nodes.some((n) => n.node === pinned && n.status === "online")) return pinned;
  }
  return pickNode();
}

/**
 * Pick the online node with the fewest Conduit containers (spreads load across the
 * cluster). Falls back to the configured NODE on any error / single-node setup.
 */
async function pickNode(): Promise<string> {
  try {
    const [nodes, res] = await Promise.all([api.nodes(), api.clusterResources()]);
    const online = nodes.filter((n) => n.status === "online").map((n) => n.node);
    if (online.length <= 1) return online[0] ?? NODE;
    const count = new Map(online.map((n) => [n, 0]));
    for (const r of res) {
      if (r.type === "lxc" && r.node && r.vmid && r.vmid >= VMID_FROM && r.vmid <= VMID_TO &&
          parseTags(r.tags).includes(CONDUIT_TAG) && count.has(r.node)) {
        count.set(r.node, (count.get(r.node) ?? 0) + 1);
      }
    }
    // fewest containers, ties broken by node name for stability
    return [...count.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
  } catch {
    return NODE;
  }
}

async function provision(task: Task, group: Group): Promise<number> {
  const bp = blueprint(task.blueprintId);
  if (!bp) throw new Error(`unknown blueprint ${task.blueprintId}`);
  await ensurePool(group);

  // Honor a pinned node if set + still valid; otherwise auto-pick the least-loaded one.
  const node = await resolveNode(task.node);

  // FAST PATH: if a golden image exists for this egg on the picked node, linked-clone it
  // (seconds) instead of a from-scratch install (minutes). Software is already baked.
  // On any clone failure, fall through to the from-scratch path so scaling never stalls.
  const db = await getDB();
  const tmpl = imageFor(db.images, task.blueprintId, node);
  if (tmpl) {
    try {
      const cloned = await cloneInstance(task, group, node, tmpl);
      noteCreate(task.id, cloned);
      return cloned;
    } catch (e) {
      console.error(`[conduitd] clone ${task.id} from ${tmpl} failed, falling back to install:`, String(e));
    }
  }

  const vmid = await api.nextVmid(VMID_FROM, VMID_TO);
  noteCreate(task.id, vmid);
  try {

  const tags = [CONDUIT_TAG, taskTag(task.id), groupTag(group.id), bp.role].join(";");
  const params: Record<string, string | number> = {
    vmid,
    hostname: `${task.id}-${vmid}`,
    ostemplate: bp.base,
    storage: "local-lvm",
    rootfs: `local-lvm:${task.disk}`,
    cores: task.cores,
    memory: task.memory,
    swap: 256,
    unprivileged: 1,
    // systemd inside an unprivileged LXC needs nesting to manage cgroups/services
    // (otherwise: "Systemd 252 detected. You may need to enable nesting.")
    features: "nesting=1",
    onboot: 1,
    net0: "name=eth0,bridge=vmbr0,ip=dhcp",
    tags,
    pool: group.id,
    start: 1,
    description: `Conduit ${bp.name} · task=${task.id} group=${group.id}\nprovision: ${bp.provision}`,
  };

  const upid = await api.createLxc(params, node);
  await waitTask(upid, node).catch(() => {});

  // Shared read-only asset store (Hytale-style: many servers share one /assets copy).
  // Bind mounts are rejected for API tokens (root@pam-only), so set it over SSH as root
  // and reboot to apply. MC blueprints don't opt in — a Paper server owns its world.
  if (ASSETS_DIR && bp.sharedAssets) {
    const host = await nodeIp(node);
    await nodeExec(
      `pct set ${vmid} -mp0 ${ASSETS_DIR},mp=/assets,ro=1 && pct reboot ${vmid}`,
      60_000,
      host,
    ).catch((e) => console.error(`[conduitd] assets mount ${vmid} failed:`, String(e)));
  }
  return vmid;
  } catch (e) {
    // A failed provision must not leave a phantom in the in-flight set (it would inflate
    // `have` and could drive an erroneous scale-down). Best-effort destroy any half-made CT.
    noteForget(task.id, vmid);
    await api.deleteLxc(vmid, node).catch(() => {});
    throw e;
  }
}

/** Keep `preparedPool` STOPPED, pre-cloned warm instances ready (golden image required). */
async function maintainWarmPool(
  task: Task, group: Group, prepared: Instance[], images: ImageStatus[] | undefined, log: string[],
): Promise<void> {
  const want = task.preparedPool ?? 0;
  // include recently-created prepared clones not yet visible in the cluster cache
  const have = prepared.length;
  for (let i = have; i < want; i++) {
    const node = await pickNode();
    const tmpl = imageFor(images, task.blueprintId, node);
    if (!tmpl) { log.push(`warmpool ${task.id}: no golden image on ${node} — skipping`); return; }
    const vmid = await clonePrepared(task, group, node, tmpl);
    log.push(`* ${task.id}: warm clone ${vmid} ready on ${node}`);
  }
}

async function destroy(inst: Instance) {
  if (inst.status === "running") {
    const upid = await api.lxcAction(inst.vmid, "stop", inst.node).catch(() => null);
    if (upid) await waitTask(upid, inst.node).catch(() => {});
  }
  const upid = await api.deleteLxc(inst.vmid, inst.node).catch(() => null);
  if (upid) await waitTask(upid, inst.node).catch(() => {});
  forgetVelocity(inst.vmid);
}

/**
 * Enable world-sharding on a task and apply ONE shared seed across every region instance,
 * regenerating each world so the terrain is continuous (different seeds = same X/Z is different
 * terrain). DESTRUCTIVE — wipes each instance's current world; the explicit operator-approved
 * "enable sharding" flow calls this. `seed` empty → mint a fresh one. Returns {seed, regenerated}.
 */
export async function enableShardingWithSeed(taskId: string, seed?: string): Promise<{ seed: string; regenerated: number }> {
  const finalSeed = (seed && seed.trim()) ? seed.trim() : String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
  let cfg: Task["sharding"] | undefined;
  await mutate((db) => {
    const t = db.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error("task not found");
    t.sharding = {
      enabled: true,
      world: t.sharding?.world ?? "world",
      stripWidth: t.sharding?.stripWidth ?? 5000,
      splitEnd: t.sharding?.splitEnd ?? true,
      borderCancelRange: t.sharding?.borderCancelRange ?? 30,
      seed: finalSeed,
    };
    cfg = t.sharding;
  });
  void cfg;
  const all = await discoverInstances();
  const mine = instancesOf(all, taskId).filter((i) => i.status === "running" && !i.tags?.includes(PREPARED_TAG));
  let regenerated = 0;
  for (const inst of mine) {
    try {
      const host = await nodeIp(inst.node);
      await regenWorldWithSeed(inst.vmid, finalSeed, host);
      regenerated++;
    } catch (e) {
      console.error(`[conduitd] regen ${inst.vmid} failed:`, String(e));
    }
  }
  return { seed: finalSeed, regenerated };
}

/** Destroy every live instance of a task (used when a task/group is deleted). */
export async function decommissionTask(taskId: string): Promise<number> {
  const all = await discoverInstances();
  const mine = instancesOf(all, taskId);
  for (const inst of mine) await destroy(inst).catch(() => {});
  recent.delete(taskId);
  return mine.length;
}

/**
 * Permanently delete a single instance and lower its task's target so the controller doesn't
 * immediately re-provision it (otherwise reconcile restarts/recreates it). This is the explicit
 * operator delete — the only way a persistent instance is destroyed (auto-GC never touches them).
 * Returns the task id, or null if the vmid isn't a Conduit instance.
 */
export async function destroyInstance(vmid: number): Promise<string | null> {
  const all = await discoverInstances();
  const inst = all.find((i) => i.vmid === vmid);
  if (!inst) return null;
  await destroy(inst);
  noteForget(inst.taskId, vmid);
  if (inst.taskId) {
    // Clamp the task target to the instances that remain — only LOWER desired when the deletion
    // would otherwise leave fewer than wanted. Deleting a SURPLUS (over-provisioned) instance
    // therefore leaves the wanted count untouched (e.g. want 2, had 3, delete 1 → still want 2,
    // shows 2/2). Deleting one of the wanted instances lowers the target by one (want 2 → 1).
    const remaining = all.filter(
      (i) => i.taskId === inst.taskId && i.vmid !== vmid && !i.tags?.includes(PREPARED_TAG),
    ).length;
    await mutate((db) => {
      const t = db.tasks.find((x) => x.id === inst.taskId);
      if (!t) return;
      t.desired = Math.min(t.desired, remaining);
      if (t.min > t.desired) t.min = t.desired;
    }).catch(() => {});
  }
  // Immediately drop the stale routing entry: re-render every proxy's velocity.toml from the
  // now-live backends (the deleted vmid is gone from a fresh discovery) and reload Velocity.
  // Done inline (not just via the post-delete reconcile, which may be skipped if one is busy).
  try {
    const db = await getDB();
    const fresh = await discoverInstances();
    await velocityPass(db, fresh, []);
  } catch { /* the next reconcile will reconcile routing anyway */ }
  return inst.taskId || null;
}

/** One reconcile pass over every task. Returns a short action log. */
export async function reconcileAll(): Promise<string[]> {
  // Single-flight across the whole process (incl. separate Next module instances): the check +
  // set has no await between them, so it's an atomic guard on JS's single thread.
  if (ctl.busy) return ["skip: busy"];
  if (ctl.restores > 0) return ["skip: restore in progress"];
  ctl.busy = true;
  const log: string[] = [];
  // Autoscale desired-count updates collected during the tick and applied via mutate() at the
  // end. NEVER saveDB(db) wholesale here: `db` was read at tick start, and a long tick would
  // clobber anything written to the store meanwhile (schedules/templates silently vanished).
  const desiredChanges = new Map<string, number>();
  try {
    await loadBlueprints(); // refresh custom templates so blueprint() sees them
    const db = await getDB();
    const all = await discoverInstances();

    // Sample players + live containers (+ per-vmid players) into the metrics history.
    try {
      const running = all.filter((i) => i.status === "running").length;
      const perVmid: Record<number, number> = {};
      for (const [vmid, s] of connServersByVmid()) perVmid[vmid] = s.online ?? 0;
      recordMetrics(allPlayers().length, running, perVmid);
    } catch { /* non-critical */ }

    // SAFETY: never act on a suspiciously-empty desired state while real conduit
    // instances exist. An empty store almost always means a state-load failure
    // (agent unreachable → {} fallback, or a not-yet-seeded shared file), NOT an
    // intent to tear down the whole network. Acting here would GC every container.
    if (db.tasks.length === 0 && db.groups.length === 0 && all.length > 0) {
      ctl.busy = false;
      return [`skip: empty desired state but ${all.length} live conduit instance(s) — refusing to GC (likely state-load failure)`];
    }

    // Two-way sync each task ⇄ tasks/<id>/task.yaml on the shared store. If a YAML was
    // edited externally, apply it into the store before reconciling so changes take effect.
    if (db.tasks.length) {
      try {
        const imported = await syncTaskFiles(db, log);
        if (imported) Object.assign(db, await getDB()); // pick up the mutate() result
      } catch (e) {
        log.push(`! task file sync failed: ${String(e)}`);
      }
    }

    // Live player counts from the connector (drives desired + safe drain).
    const autoTasks = db.tasks.filter((t) => t.autoscale);
    const players = autoTasks.length
      ? playerCounts(autoTasks.flatMap((t) => instancesOf(all, t.id)))
      : new Map<number, number>();

    for (const task of db.tasks) {
      const group = db.groups.find((g) => g.id === task.groupId);
      if (!group) continue;

      // Prepared (warm-pool) instances are a separate pool — exclude them from live accounting.
      const allOfTask = instancesOf(all, task.id);
      const preparedInsts = allOfTask.filter((i) => i.tags?.includes(PREPARED_TAG));
      const live = allOfTask.filter((i) => !i.tags?.includes(PREPARED_TAG));
      // count live + recently-created (not yet visible in cluster cache)
      const liveIds = new Set(live.map((i) => i.vmid));
      const pending = recentVmids(task.id).filter((v) => !liveIds.has(v));
      const have = live.length + pending.length;

      // Effective cap: maxServices overrides max when set (CloudNet Smart parity).
      const cap = task.maxServices && task.maxServices > 0 ? task.maxServices : task.max;
      let desired: number;
      if (task.autoscale) {
        const load = live.reduce((n, i) => n + (players.get(i.vmid) ?? 0), 0);
        desired = autoscaleTarget(load, task.playersPerInstance, task.min, cap, task.scaleUpPercent);
        if (desired !== task.desired) {
          task.desired = desired; // reflect the live target for the rest of this tick
          desiredChanges.set(task.id, desired);
        }
        if (desired !== have)
          log.push(`autoscale ${task.id}: ${load}p → want ${desired} (have ${have})`);
      } else {
        desired = clamp(task.desired, task.min, cap > 0 ? cap : task.desired);
      }

      // Restart any stopped containers that should be running — a crash or manual
      // stop leaves the CT in Proxmox but the controller previously ignored it,
      // counting it against `have` while leaving it offline.
      for (const inst of live) {
        if (inst.status === "stopped") {
          try {
            await api.lxcAction(inst.vmid, "start", inst.node);
            log.push(`~ ${task.id}: restarted stopped instance ${inst.vmid}`);
          } catch (e) {
            log.push(`! ${task.id}: failed to start ${inst.vmid}: ${String(e)}`);
          }
        }
      }

      const now = Date.now();
      if (have < desired) {
        // Honor a spawn cooldown so a burst doesn't create a thundering herd of clones.
        const cooldownMs = (task.spawnCooldownSec ?? 0) * 1000;
        const lastTs = lastSpawn.get(task.id) ?? 0;
        if (cooldownMs > 0 && now - lastTs < cooldownMs) {
          log.push(`autoscale ${task.id}: spawn on cooldown (${Math.ceil((cooldownMs - (now - lastTs)) / 1000)}s)`);
        } else {
          const warm = preparedInsts.filter((i) => i.status === "stopped");
          for (let i = 0; i < desired - have; i++) {
            // Hard ceiling on LIVE instances: never exceed the cap regardless of `have`. The
            // in-memory in-flight dedup (`recent`) is lost on a panel restart, so without this
            // a slow provision mid-restart could be re-issued and overshoot (e.g. 3 when max=2).
            // Re-read live count each iteration since provision() can take minutes.
            const liveNow = instancesOf(await discoverInstances(), task.id).filter((x) => !x.tags?.includes(PREPARED_TAG)).length;
            const ceiling = cap > 0 ? cap : desired;
            if (liveNow >= ceiling) { log.push(`= ${task.id}: at ceiling ${ceiling}, not provisioning more`); break; }
            try {
              const w = warm.shift();
              if (w) {
                await promotePrepared(w.vmid, w.node, task, group);
                noteCreate(task.id, w.vmid);
                log.push(`+ ${task.id}: promoted warm ${w.vmid}`);
              } else {
                const vmid = await provision(task, group);
                log.push(`+ ${task.id}: provisioned ${vmid}`);
              }
            } catch (e) {
              log.push(`! ${task.id}: scale-up failed ${String(e)}`);
            }
          }
          lastSpawn.set(task.id, now);
        }
      } else if (live.length > desired) {
        // Scale down is driven by the LIVE excess only — never by `have` (which includes
        // in-flight `pending` creations); a failed/slow provision must not trigger destroys
        // of real instances.
        if (task.persistent) {
          // SAFETY: persistent instances own data — the controller never auto-destroys them.
          // Removing one is an explicit operator action (decommission/delete in the UI).
          log.push(`= ${task.id}: ${live.length} live > desired ${desired}, persistent — NOT auto-destroying (remove manually)`);
        } else {
          // prefer stopped, then highest vmid; for autoscale only drain EMPTY instances idle
          // ≥ scaleDownAfterSec (CloudNet auto-stop) so we never kick players or flap.
          let removable = [...live].sort(
            (a, b) =>
              Number(a.status === "running") - Number(b.status === "running") ||
              b.vmid - a.vmid,
          );
          if (task.autoscale) {
            const idleMs = (task.scaleDownAfterSec ?? 60) * 1000;
            removable = removable.filter((i) => {
              if ((players.get(i.vmid) ?? 0) !== 0) return false;
              const since = emptySince.get(i.vmid) ?? now;
              return now - since >= idleMs;
            });
          }
          for (let i = 0; i < live.length - desired && removable.length; i++) {
            const victim = removable.shift()!;
            try {
              await destroy(victim);
              emptySince.delete(victim.vmid);
              log.push(`- ${task.id}: destroyed ${victim.vmid}`);
            } catch (e) {
              log.push(`! ${task.id}: destroy failed ${String(e)}`);
            }
          }
        }
      }

      // Track empty-since timestamps for the idle-drain delay (autoscale tasks only).
      if (task.autoscale) {
        for (const inst of live) {
          if ((players.get(inst.vmid) ?? 0) === 0) {
            if (!emptySince.has(inst.vmid)) emptySince.set(inst.vmid, now);
          } else emptySince.delete(inst.vmid);
        }
      }

      // Warm pool: keep `preparedPool` pre-cloned, STOPPED instances ready for instant
      // scale-up. Only meaningful when a golden image exists for the egg (clones are cheap).
      if (task.autoscale && (task.preparedPool ?? 0) > 0) {
        await maintainWarmPool(task, group, preparedInsts, db.images, log)
          .catch((e) => log.push(`! warmpool ${task.id}: ${String(e)}`));
      }
    }

    // GC orphans: conduit instances whose task no longer exists (e.g. a failed
    // decommission left the container running). Only ever our own tagged instances.
    const taskIds = new Set(db.tasks.map((t) => t.id));
    const pendingVmids = new Set(db.tasks.flatMap((t) => recentVmids(t.id)));
    for (const inst of all) {
      if (inst.taskId && !taskIds.has(inst.taskId) && !pendingVmids.has(inst.vmid)) {
        try {
          await destroy(inst);
          log.push(`gc orphan ${inst.vmid} (task ${inst.taskId} gone)`);
        } catch (e) {
          log.push(`! gc ${inst.vmid} failed: ${String(e)}`);
        }
      }
    }

    // software provisioning (background) + proxy routing config push
    provisionPass(db, all, log);
    await velocityPass(db, all, log);
    await redisPass(db, all, log);
    await pgPass(db, all);
    await autoUpdatePass(db, all, log);
    await templateSyncPass(db, log);

    if (desiredChanges.size) {
      await mutate((d) => {
        for (const [id, want] of desiredChanges) {
          const x = d.tasks.find((t) => t.id === id);
          if (x) x.desired = want;
        }
      }).catch(() => {});
    }
  } catch (e) {
    log.push(`! reconcile error: ${String(e)}`);
  } finally {
    ctl.busy = false;
  }
  recordReconcile(log); // surface acted lines in the Activity feed
  return log;
}

// The periodic reconcile loop lives in src/instrumentation.ts (the Next.js bootstrap
// hook), which is leader-gated on the VIP for the HA panel-per-node deployment.
// Keeping a single loop there avoids double reconciles on the leader.

/** Proxy routing tables: for each proxy task, its fronted backends + IPs. */
export async function routingTables() {
  const db = await getDB();
  const all = await discoverInstances();
  const proxies = db.tasks.filter((t) => blueprint(t.blueprintId)?.role === "proxy");

  return proxies.map((proxy) => ({
    proxy: { id: proxy.id, name: proxy.name },
    proxyInstances: instancesOf(all, proxy.id).map((i) => ({
      vmid: i.vmid,
      ip: i.ip,
      status: i.status,
    })),
    backends: proxy.fronts.flatMap((backendId) => {
      const t = db.tasks.find((x) => x.id === backendId);
      const bp = t ? blueprint(t.blueprintId) : undefined;
      return instancesOf(all, backendId).map((i) => ({
        taskId: backendId,
        taskName: t?.name ?? backendId,
        role: bp?.role ?? "generic",
        vmid: i.vmid,
        name: i.name,
        ip: i.ip,
        port: bp?.port ?? 25565,
        status: i.status,
      }));
    }),
  }));
}
