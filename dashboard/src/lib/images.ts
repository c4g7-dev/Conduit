/**
 * Golden-image fast autoscaling. For each egg we build a Proxmox CT **template** per node
 * (software + connector baked in, world/logs/identity stripped). Scale-ups then `pct clone`
 * (linked) that template locally — seconds instead of the minutes a from-scratch install
 * takes. Linked clones are node-local on LVM-thin, so the template is built on every node.
 *
 * The clone re-identifies itself by rewriting the connector EnvironmentFile (see
 * reidentifyConnector in provision.ts), then starts.
 */
import { api, nodeIp, waitTask, lxcIp, NODE } from "./proxmox";
import { blueprint } from "./blueprints";
import {
  installPaper, installVelocity, installNginx, installConnector, nodeExec, reidentifyConnector,
} from "./provision";
import { mutate, type Task, type Group, type ImageStatus } from "./store";
import { pushEvent } from "./events";

const IMAGE_TAG = "conduit-image";
const VMID_FROM = 900, VMID_TO = 990; // template vmids live in a high band

const nextSig = (s: ImageStatus | undefined) => (s?.version ?? 0) + 1;

/** Build/refresh the golden template for an egg on every node. Leader-only; idempotent. */
export async function buildImage(eggId: string): Promise<void> {
  const bp = blueprint(eggId);
  if (!bp) throw new Error(`unknown egg ${eggId}`);
  const kind = bp.software.kind;
  if (!["paper", "velocity", "nginx"].includes(kind)) throw new Error(`egg ${eggId} not cloneable (${kind})`);

  const nodes = (await api.nodes()).map((n) => n.node);
  await setStatus(eggId, (s) => ({
    eggId, templates: s?.templates ?? {}, version: s?.version ?? 0, builtAt: s?.builtAt ?? 0,
    building: true, error: undefined,
  }));
  const templates: Record<string, number> = {};

  try {
    for (const node of nodes) {
      const vmid = await api.nextVmid(VMID_FROM, VMID_TO);
      const host = await nodeIp(node);
      // synthetic task carrying the egg defaults (clones overwrite identity later)
      const t: Task = {
        id: `image-${eggId}`, name: "image", groupId: "image", blueprintId: eggId,
        mode: "static", desired: 1, min: 1, max: 1, autoscale: false, playersPerInstance: 0,
        cores: bp.cores, memory: bp.memory, disk: bp.disk, persistent: false, fronts: [],
        createdAt: Date.now(),
      };
      pushEvent(`image ${eggId}: building golden CT ${vmid} on ${node}`);

      // 1) create a standalone CT from the OS template
      const upid = await api.createLxc({
        vmid, hostname: `image-${eggId}-${vmid}`, ostemplate: bp.base, storage: "local-lvm",
        rootfs: `local-lvm:${bp.disk}`, cores: bp.cores, memory: bp.memory, swap: 256,
        unprivileged: 1, features: "nesting=1", onboot: 0,
        net0: "name=eth0,bridge=vmbr0,ip=dhcp", tags: `${IMAGE_TAG};${eggId}`, start: 1,
        description: `Conduit golden image · egg=${eggId}`,
      }, node);
      await waitTask(upid, node).catch(() => {});
      // wait for an IP (needed for software download)
      for (let i = 0; i < 30 && !(await lxcIp(vmid, node)); i++) await sleep(2000);

      // 2) install software + connector (the slow part, done once)
      if (kind === "paper") await installPaper(vmid, t, "image-secret", {}, "1.20.4", host);
      else if (kind === "velocity") await installVelocity(vmid, t, "image-secret", "3.4.0", host);
      else if (kind === "nginx") await installNginx(vmid, host);
      if (kind === "paper" || kind === "velocity") await installConnector(vmid, host).catch(() => {});

      // 3) clean so clones re-seed: stop the server, strip world/logs/identity/ready marker
      await nodeExec(
        `pct exec ${vmid} -- bash -c 'systemctl stop mc 2>/dev/null; rm -rf /opt/mc/world* /opt/mc/logs/* /opt/mc/.conduit-ready /etc/conduit/connector.env 2>/dev/null; true'`,
        60_000, host,
      ).catch(() => {});
      // 4) stop the CT and convert to a template
      await api.lxcAction(vmid, "stop", node).catch(() => {});
      for (let i = 0; i < 20; i++) { const st = await api.lxcStatus(vmid, node).catch(() => null); if ((st as { status?: string })?.status === "stopped") break; await sleep(1500); }
      await nodeExec(`pct template ${vmid}`, 30_000, host);

      templates[node] = vmid;
      pushEvent(`image ${eggId}: template ${vmid} ready on ${node}`);
    }

    await setStatus(eggId, (s) => ({
      eggId, templates, version: nextSig(s), builtAt: Date.now(), building: false, error: undefined,
    }));
    pushEvent(`image ${eggId}: built on ${Object.keys(templates).length} node(s)`);
  } catch (e) {
    await setStatus(eggId, (s) => ({ ...(s ?? { eggId, templates: {}, version: 0, builtAt: 0 }), building: false, error: String(e) }));
    pushEvent(`! image ${eggId} build failed: ${String(e)}`, "error");
    throw e;
  }
}

/** Template vmid for an egg on a given node, or undefined if not built there. */
export function imageFor(images: ImageStatus[] | undefined, eggId: string, node: string): number | undefined {
  return images?.find((i) => i.eggId === eggId && !i.building)?.templates[node];
}

/**
 * Linked-clone a golden template into a new instance for `task` on `node`, re-identify it,
 * and start it. Returns the new vmid. Much faster than a from-scratch provision.
 */
export async function cloneInstance(task: Task, group: Group, node: string, templateVmid: number): Promise<number> {
  const bp = blueprint(task.blueprintId);
  const vmid = await api.nextVmid();
  const host = await nodeIp(node);
  const tags = ["conduit", `task=${task.id}`, `group=${group.id}`, bp?.role ?? "generic", "ready"].join(";");

  // linked clone (full:0) on the same node — needs the source to be a template (it is).
  // Retry on transient "CT is locked (disk)" (template briefly locks during/after creation).
  const upid = await cloneWithRetry(templateVmid, vmid, { full: 0, hostname: `${task.id}-${vmid}`, pool: group.id }, node);
  await waitTask(upid, node).catch(() => {});
  try {
    // CRITICAL: overwrite the inherited template tags with this task's tags so discoverInstances
    // recognizes the instance. The CT can be briefly disk-locked post-clone — retry (don't swallow).
    await setConfigWithRetry(vmid, { cores: task.cores, memory: task.memory, tags }, node);
    await api.lxcAction(vmid, "start", node).catch(() => {});
    for (let i = 0; i < 20 && !(await lxcIp(vmid, node)); i++) await sleep(1500);
    // re-identify the connector (rewrite EnvironmentFile to this task/vmid) + restart mc
    await reidentifyConnector(vmid, task, host).catch(() => {});
    return vmid;
  } catch (e) {
    // Don't leak a half-configured clone (it'd carry the template's `conduit-image` tags and
    // the GC wouldn't reclaim it). Destroy it and let the caller fall back to a fresh install.
    await api.lxcAction(vmid, "stop", node).catch(() => {});
    await api.deleteLxc(vmid, node).catch(() => {});
    throw e;
  }
}

export const PREPARED_TAG = "prepared";

/** Clone a golden template into a STOPPED, `prepared`-tagged warm-pool instance (not started,
 *  not yet identified — that happens on promotion). */
export async function clonePrepared(task: Task, group: Group, node: string, templateVmid: number): Promise<number> {
  const bp = blueprint(task.blueprintId);
  const vmid = await api.nextVmid();
  const tags = ["conduit", `task=${task.id}`, `group=${group.id}`, bp?.role ?? "generic", PREPARED_TAG].join(";");
  const upid = await api.cloneLxc(templateVmid, vmid, { full: 0, hostname: `${task.id}-prep-${vmid}`, pool: group.id }, node);
  await waitTask(upid, node).catch(() => {});
  await api.setLxcConfig(vmid, { cores: task.cores, memory: task.memory, tags }, node).catch(() => {});
  return vmid; // left stopped
}

/** Promote a prepared warm-pool instance into a live one: drop the prepared tag, start it,
 *  re-identify the connector. Returns when started (fast — already installed + cloned). */
export async function promotePrepared(vmid: number, node: string, task: Task, group: Group): Promise<void> {
  const bp = blueprint(task.blueprintId);
  const host = await nodeIp(node);
  const tags = ["conduit", `task=${task.id}`, `group=${group.id}`, bp?.role ?? "generic", "ready"].join(";");
  await setConfigWithRetry(vmid, { hostname: `${task.id}-${vmid}`, tags }, node);
  await api.lxcAction(vmid, "start", node).catch(() => {});
  for (let i = 0; i < 20 && !(await lxcIp(vmid, node)); i++) await sleep(1500);
  await reidentifyConnector(vmid, task, host).catch(() => {});
}

async function setStatus(eggId: string, fn: (cur: ImageStatus | undefined) => ImageStatus): Promise<void> {
  await mutate((db) => {
    db.images ??= [];
    const i = db.images.findIndex((x) => x.eggId === eggId);
    const next = fn(i >= 0 ? db.images[i] : undefined);
    if (i >= 0) db.images[i] = next; else db.images.push(next);
  });
}

/** Clone with retry on the transient template disk lock that appears right after templating. */
async function cloneWithRetry(
  src: number, newid: number, params: Record<string, string | number>, node: string, tries = 4,
): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await api.cloneLxc(src, newid, params, node);
    } catch (e) {
      if (i >= tries - 1 || !/lock/i.test(String(e))) throw e;
      await sleep(3000); // wait for the template lock to clear, then retry
    }
  }
}

/** setLxcConfig with retry — a freshly-cloned CT can be briefly disk-locked. Must succeed so
 *  the instance gets its task tags (else discoverInstances won't recognize it → runaway). */
async function setConfigWithRetry(
  vmid: number, params: Record<string, string | number>, node: string, tries = 6,
): Promise<void> {
  for (let i = 0; ; i++) {
    try { await api.setLxcConfig(vmid, params, node); return; }
    catch (e) {
      if (i >= tries - 1) throw new Error(`setLxcConfig ${vmid} failed after retries: ${String(e)}`);
      await sleep(2500);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
void NODE;
