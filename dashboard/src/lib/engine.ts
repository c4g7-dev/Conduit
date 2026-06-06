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
import { api, lxcIp, waitTask, NODE } from "./proxmox";
import { blueprint, type Blueprint } from "./blueprints";
import { getDB, saveDB, getNetwork, type Task, type Group } from "./store";
import {
  installPaper,
  installVelocity,
  syncVelocity,
  forgetVelocity,
  type ProxyServer,
} from "./provision";
import { pingMc } from "./mcping";

export const CONDUIT_TAG = "conduit";
export const READY_TAG = "ready";
const VMID_FROM = 200;
const VMID_TO = 999;

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
  for (const [vmid, ts] of m) if (now - ts > 90_000) m.delete(vmid);
  return [...m.keys()];
}

// Instances whose software install is currently running (takes minutes — we kick
// it in the background and let later ticks skip it until the `ready` tag lands).
const provisioning = new Set<number>();

let busy = false;

/** Install the role's MC software inside a running instance, then tag it ready. */
async function provisionInstance(inst: Instance, task: Task, bp: Blueprint) {
  const net = await getNetwork();
  if (bp.role === "proxy") {
    await installVelocity(inst.vmid, task, net.forwardingSecret);
  } else if (bp.role === "lobby" || bp.role === "smp") {
    // task seed overrides/extends the blueprint's default seed
    const seed = {
      ...bp.seed,
      ...task.seed,
      properties: { ...bp.seed?.properties, ...task.seed?.properties },
      plugins: [...(bp.seed?.plugins ?? []), ...(task.seed?.plugins ?? [])],
    };
    await installPaper(inst.vmid, task, net.forwardingSecret, seed);
  } else {
    return; // db/generic: container lifecycle only, no MC software (yet)
  }
  const tags = inst.tags ? `${inst.tags};${READY_TAG}` : READY_TAG;
  await api.setLxcConfig(inst.vmid, { tags }, inst.node);
}

/** Kick background software installs for any running, un-provisioned instance. */
function provisionPass(db: Awaited<ReturnType<typeof getDB>>, all: Instance[], log: string[]) {
  for (const inst of all) {
    if (inst.status !== "running" || !inst.ip || inst.ready) continue;
    if (provisioning.has(inst.vmid)) continue;
    const task = db.tasks.find((t) => t.id === inst.taskId);
    const bp = task ? blueprint(task.blueprintId) : undefined;
    if (!task || !bp || bp.role === "db" || bp.role === "generic") continue;

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
        .map((i) => ({ name: `${ft.name}-${i.vmid}`, ip: i.ip!, port: fbp.port }));
    });
    if (servers.length === 0) continue;

    for (const p of instancesOf(all, proxy.id).filter(ready)) {
      try {
        if (await syncVelocity(p.vmid, proxy, servers))
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

  const out: Instance[] = [];
  for (const c of cts) {
    const tags = parseTags(c.tags);
    const tTag = tags.find((t) => t.startsWith("t-"));
    const taskId = tTag ? tTag.slice(2) : "";
    out.push({
      vmid: c.vmid!,
      name: c.name ?? `ct-${c.vmid}`,
      node: c.node ?? NODE,
      status: c.status ?? "unknown",
      taskId,
      ip: c.status === "running" ? await lxcIp(c.vmid!, c.node ?? NODE) : null,
      tags: c.tags ?? "",
      ready: tags.includes(READY_TAG),
    });
  }
  return out;
}

export function instancesOf(all: Instance[], taskId: string): Instance[] {
  return all.filter((i) => i.taskId === taskId);
}

/** Live online-player count per vmid via SLP (best-effort; unreachable → absent). */
async function playerCounts(
  insts: Instance[],
  portOf: (i: Instance) => number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  await Promise.all(
    insts
      .filter((i) => i.status === "running" && i.ip && i.ready)
      .map(async (i) => {
        try {
          const p = await pingMc(i.ip!, portOf(i), 2000);
          out.set(i.vmid, p.online);
        } catch {
          /* not up yet / unreachable — leave absent */
        }
      }),
  );
  return out;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));

/** Autoscale target for a dynamic task: one spare joinable server above current load. */
export function autoscaleTarget(players: number, perInstance: number, min: number, max: number) {
  const per = Math.max(1, perInstance);
  const loadBased = Math.ceil(players / per) + 1; // +1 keeps a fresh lobby ready
  const cap = max > 0 ? max : loadBased;
  return clamp(loadBased, min, cap);
}

async function ensurePool(group: Group) {
  const pools = await api.pools().catch(() => []);
  if (!pools.some((p) => p.poolid === group.id)) {
    await api.createPool(group.id, `Conduit group: ${group.name}`).catch(() => {});
  }
}

async function provision(task: Task, group: Group): Promise<number> {
  const bp = blueprint(task.blueprintId);
  if (!bp) throw new Error(`unknown blueprint ${task.blueprintId}`);
  await ensurePool(group);

  const vmid = await api.nextVmid(VMID_FROM, VMID_TO);
  noteCreate(task.id, vmid);

  const tags = [CONDUIT_TAG, taskTag(task.id), groupTag(group.id), bp.role].join(";");
  const upid = await api.createLxc({
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
  });
  await waitTask(upid).catch(() => {});
  return vmid;
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
  busy = true;
  const log: string[] = [];
  let dirty = false;
  try {
    const db = await getDB();
    const all = await discoverInstances();

    // Gather live player counts once if any task autoscales (drives desired + safe drain).
    const autoTasks = db.tasks.filter((t) => t.autoscale);
    const portOf = (i: Instance) => {
      const t = db.tasks.find((x) => x.id === i.taskId);
      return (t ? blueprint(t.blueprintId)?.port : undefined) ?? 25565;
    };
    const players = autoTasks.length
      ? await playerCounts(
          autoTasks.flatMap((t) => instancesOf(all, t.id)),
          portOf,
        )
      : new Map<number, number>();

    for (const task of db.tasks) {
      const group = db.groups.find((g) => g.id === task.groupId);
      if (!group) continue;

      const live = instancesOf(all, task.id);
      // count live + recently-created (not yet visible in cluster cache)
      const liveIds = new Set(live.map((i) => i.vmid));
      const pending = recentVmids(task.id).filter((v) => !liveIds.has(v));
      const have = live.length + pending.length;

      let desired: number;
      if (task.autoscale) {
        const load = live.reduce((n, i) => n + (players.get(i.vmid) ?? 0), 0);
        desired = autoscaleTarget(load, task.playersPerInstance, task.min, task.max);
        if (desired !== task.desired) {
          task.desired = desired; // reflect the live target in the store/UI
          dirty = true;
        }
        if (desired !== have)
          log.push(`autoscale ${task.id}: ${load}p → want ${desired} (have ${have})`);
      } else {
        desired = clamp(task.desired, task.min, task.max > 0 ? task.max : task.desired);
      }

      if (have < desired) {
        for (let i = 0; i < desired - have; i++) {
          try {
            const vmid = await provision(task, group);
            log.push(`+ ${task.id}: provisioned ${vmid}`);
          } catch (e) {
            log.push(`! ${task.id}: provision failed ${String(e)}`);
          }
        }
      } else if (have > desired) {
        // scale down: prefer stopped, then highest vmid; never below min.
        // For autoscale tasks, only drain EMPTY instances so we never kick players.
        let removable = [...live].sort(
          (a, b) =>
            Number(a.status === "running") - Number(b.status === "running") ||
            b.vmid - a.vmid,
        );
        if (task.autoscale)
          removable = removable.filter((i) => (players.get(i.vmid) ?? 0) === 0);
        for (let i = 0; i < have - desired && removable.length; i++) {
          const victim = removable.shift()!;
          try {
            await destroy(victim);
            log.push(`- ${task.id}: destroyed ${victim.vmid}`);
          } catch (e) {
            log.push(`! ${task.id}: destroy failed ${String(e)}`);
          }
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
  return log;
}

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
