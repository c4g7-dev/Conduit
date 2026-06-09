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
import { getDB, saveDB, getNetwork, type Task, type Group, type ImageStatus } from "./store";
import {
  installPaper,
  installVelocity,
  installHytale,
  installNginx,
  installConnector,
  syncVelocity,
  forgetVelocity,
  nodeExec,
  pushInstallLog,
  ctExec,
  type ProxyServer,
} from "./provision";
import { connServersByVmid } from "./metrics-source";
import { imageFor, cloneInstance, clonePrepared, promotePrepared, PREPARED_TAG } from "./images";
import { applyTemplate, serviceDir } from "./templates";
import { ensureServiceShare } from "./serviceshare";
import { syncTaskFiles } from "./taskfile";
import { assetNodePath } from "./assets";
import { recordReconcile } from "./events";

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

// Containers we just asked Proxmox to create — cluster/resources lags ~10s, so
// remember them briefly to avoid double-provisioning on the next tick.
const recent = new Map<string, Map<number, number>>(); // taskId -> vmid -> ts
function noteCreate(taskId: string, vmid: number) {
  if (!recent.has(taskId)) recent.set(taskId, new Map());
  recent.get(taskId)!.set(vmid, Date.now());
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

// Instances whose software install is currently running (takes minutes — we kick
// it in the background and let later ticks skip it until the `ready` tag lands).
const provisioning = new Set<number>();

// Smart-autoscale timers: spawn cooldown per task, and when an instance first went empty
// (so we only scale it down after `scaleDownAfterSec` of idle, like CloudNet's auto-stop).
const lastSpawn = new Map<string, number>(); // taskId -> ts of last provision
const emptySince = new Map<number, number>(); // vmid -> ts it first appeared empty

let busy = false;

// While a restore is in flight the target CT is stopped/replaced; pause reconcile
// so the controller doesn't mistake it for a missing instance and spawn a duplicate.
let restores = 0;
export function beginRestore() {
  restores++;
}
export function endRestore() {
  restores = Math.max(0, restores - 1);
}

/** Install the role's MC software inside a running instance, then tag it ready. */
async function provisionInstance(inst: Instance, task: Task, bp: Blueprint) {
  const net = await getNetwork();
  const version = task.software?.version ?? bp.software.version;
  const host = await nodeIp(inst.node);
  const kind = bp.software.kind;

  if (kind === "velocity") {
    await installVelocity(inst.vmid, task, net.forwardingSecret, version, host);
  } else if (kind === "paper") {
    const merged = {
      ...bp.seed,
      ...task.seed,
      properties: { ...bp.seed?.properties, ...task.seed?.properties },
      plugins: [...(bp.seed?.plugins ?? []), ...(task.seed?.plugins ?? [])],
    };
    const seed = await resolveSeedAssets(inst, merged);
    await installPaper(inst.vmid, task, net.forwardingSecret, seed, version, host);
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
  } else {
    // generic / unknown — bare OS, show in UI, configure manually
    pushInstallLog(inst.vmid, `[conduit] Blueprint "${bp.name}" (${kind}) — no install recipe. Bare Debian container.`);
    await ctExec(inst.vmid, `echo "[conduit] Container provisioned at $(date)." > /opt/conduit-info.txt`, 30_000, host);
  }

  // CloudNet-style overlay: copy overlays/<egg>/ + tasks/<task>/ into the service dir.
  try {
    await applyTemplate(inst.vmid, bp.id, task.id, serviceDir(kind), host);
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
  if (kind === "paper" || kind === "velocity") {
    try {
      await installConnector(inst.vmid, host);
    } catch (e) {
      pushInstallLog(inst.vmid, `[conduit] connector install skipped: ${String(e)}`);
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

  const node = await pickNode();

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

/** Destroy every live instance of a task (used when a task/group is deleted). */
export async function decommissionTask(taskId: string): Promise<number> {
  const all = await discoverInstances();
  const mine = instancesOf(all, taskId);
  for (const inst of mine) await destroy(inst).catch(() => {});
  recent.delete(taskId);
  return mine.length;
}

/** One reconcile pass over every task. Returns a short action log. */
export async function reconcileAll(): Promise<string[]> {
  if (busy) return ["skip: busy"];
  if (restores > 0) return ["skip: restore in progress"];
  busy = true;
  const log: string[] = [];
  let dirty = false;
  try {
    await loadBlueprints(); // refresh custom templates so blueprint() sees them
    const db = await getDB();
    const all = await discoverInstances();

    // SAFETY: never act on a suspiciously-empty desired state while real conduit
    // instances exist. An empty store almost always means a state-load failure
    // (agent unreachable → {} fallback, or a not-yet-seeded shared file), NOT an
    // intent to tear down the whole network. Acting here would GC every container.
    if (db.tasks.length === 0 && db.groups.length === 0 && all.length > 0) {
      busy = false;
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
          task.desired = desired; // reflect the live target in the store/UI
          dirty = true;
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
      } else if (have > desired) {
        // scale down: prefer stopped, then highest vmid; never below min.
        // For autoscale tasks, only drain EMPTY instances, and only after they've been idle
        // for scaleDownAfterSec (CloudNet auto-stop) — so we never kick players or flap.
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
        for (let i = 0; i < have - desired && removable.length; i++) {
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

    if (dirty) await saveDB(db).catch(() => {});
  } catch (e) {
    log.push(`! reconcile error: ${String(e)}`);
  } finally {
    busy = false;
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
