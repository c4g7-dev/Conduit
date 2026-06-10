/**
 * Server-side network operations reused by API routes and the scheduler:
 * console broadcast, restart, and backup — against a group, subgroup (incl. nested),
 * service, or single instance. Uses the node agent (local pct exec) when available,
 * else SSH — same path as the single-server console.
 */
import { getDB, type ScheduleTarget } from "./store";
import { discoverInstances, type Instance } from "./engine";
import { nodeExec } from "./provision";
import { api, vmidHost } from "./proxmox";
import { agentUp, agentExec } from "./agent";
import { connServersByVmid } from "./metrics-source";

async function instancesForGroup(groupId: string) {
  const db = await getDB();
  const taskIds = new Set(db.tasks.filter((t) => t.groupId === groupId).map((t) => t.id));
  return (await discoverInstances()).filter(
    (i) => i.taskId && taskIds.has(i.taskId) && i.status === "running",
  );
}

type Db = Awaited<ReturnType<typeof getDB>>;

function matchTarget(all: Instance[], db: Db, target: ScheduleTarget): Instance[] {
  if (target.type === "instance") return all.filter((i) => i.vmid === target.vmid);
  let taskIds: Set<string>;
  if (target.type === "task") {
    taskIds = new Set([target.id]);
  } else if (target.type === "group") {
    taskIds = new Set(db.tasks.filter((t) => t.groupId === target.id).map((t) => t.id));
  } else {
    // subgroup — include tasks whose subgroup-parent chain reaches the target subgroup
    const sgs = db.groups.find((g) => g.id === target.groupId)?.subgroups ?? [];
    const inChain = (sgId: string | undefined) => {
      let cur = sgId;
      for (let i = 0; cur && i < 50; i++) {
        if (cur === target.id) return true;
        cur = sgs.find((s) => s.id === cur)?.parentId;
      }
      return false;
    };
    taskIds = new Set(db.tasks.filter((t) => t.groupId === target.groupId && inChain(t.subgroupId)).map((t) => t.id));
  }
  return all.filter((i) => i.taskId && taskIds.has(i.taskId));
}

/** Running instances matching schedule target(s) — union, deduped by vmid (a schedule may
 *  check overlapping targets, e.g. a group AND a service inside it). */
export async function instancesForTarget(target: ScheduleTarget | ScheduleTarget[]): Promise<Instance[]> {
  const targets = Array.isArray(target) ? target : [target];
  const all = (await discoverInstances()).filter((i) => i.status === "running");
  const db = await getDB();
  const seen = new Map<number, Instance>();
  for (const t of targets) for (const i of matchTarget(all, db, t)) seen.set(i.vmid, i);
  return [...seen.values()];
}

/** Restart one instance (systemctl restart mc via agent/SSH). */
export async function restartInstance(vmid: number): Promise<void> {
  const host = await vmidHost(vmid);
  const cmd = "systemctl restart mc";
  if (await agentUp(host)) await agentExec(host, cmd, { vmid, timeoutMs: 30_000 });
  else await nodeExec(`pct exec ${vmid} -- ${cmd}`, 30_000, host);
}

/** Console broadcast to a target's running instances. */
export async function broadcastToTarget(target: ScheduleTarget | ScheduleTarget[], command: string): Promise<{ sent: number; total: number }> {
  const targets = await instancesForTarget(target);
  const r = await Promise.allSettled(targets.map((i) => sendKeys(i.vmid, command)));
  return { sent: r.filter((x) => x.status === "fulfilled").length, total: targets.length };
}

/**
 * Restart a target's instances. With `onlyWhenEmpty`, instances that currently have players are
 * NOT restarted and are returned in `deferred` (the scheduler retries them once they empty).
 */
export async function restartTarget(target: ScheduleTarget | ScheduleTarget[], onlyWhenEmpty = false): Promise<{ restarted: number[]; deferred: number[]; total: number }> {
  const targets = await instancesForTarget(target);
  const players = onlyWhenEmpty ? connServersByVmid() : null;
  const restarted: number[] = [];
  const deferred: number[] = [];
  await Promise.allSettled(targets.map(async (i) => {
    if (onlyWhenEmpty && (players!.get(i.vmid)?.online ?? 0) > 0) { deferred.push(i.vmid); return; }
    await restartInstance(i.vmid);
    restarted.push(i.vmid);
  }));
  return { restarted, deferred, total: targets.length };
}

/** vzdump snapshot each instance of a target to `storage` (cluster-wide PVE API, per node). */
export async function backupTarget(target: ScheduleTarget | ScheduleTarget[], storage: string): Promise<{ sent: number; total: number }> {
  const targets = await instancesForTarget(target);
  const r = await Promise.allSettled(targets.map((i) =>
    api.vzdump({ storage, mode: "snapshot", compress: "zstd", vmid: i.vmid, "notes-template": "conduit {{guestname}}" }, i.node),
  ));
  return { sent: r.filter((x) => x.status === "fulfilled").length, total: targets.length };
}

/** Send one console command into a container's tmux session. */
export async function sendKeys(vmid: number, command: string) {
  const host = await vmidHost(vmid);
  const line = command.replace(/[\r\n]+/g, " ").trim();
  const b64 = Buffer.from(line, "utf8").toString("base64");
  const sk = `tmux -L mc send-keys -t mc "$(echo ${b64} | base64 -d)" Enter`;
  if (await agentUp(host)) await agentExec(host, sk, { vmid, timeoutMs: 8_000 });
  else await nodeExec(`pct exec ${vmid} -- bash -c '${sk}'`, 15_000, host);
}

/** Broadcast a console command to every running instance of a group. */
export async function broadcastToGroup(groupId: string, command: string): Promise<{ sent: number; total: number }> {
  const targets = await instancesForGroup(groupId);
  const r = await Promise.allSettled(targets.map((i) => sendKeys(i.vmid, command)));
  return { sent: r.filter((x) => x.status === "fulfilled").length, total: targets.length };
}

/** Restart every running instance of a group (systemctl restart mc via agent/SSH). */
export async function restartGroup(groupId: string): Promise<{ sent: number; total: number }> {
  const targets = await instancesForGroup(groupId);
  const r = await Promise.allSettled(
    targets.map(async (i) => {
      const host = await vmidHost(i.vmid);
      const cmd = "systemctl restart mc";
      if (await agentUp(host)) await agentExec(host, cmd, { vmid: i.vmid, timeoutMs: 30_000 });
      else await nodeExec(`pct exec ${i.vmid} -- ${cmd}`, 30_000, host);
    }),
  );
  return { sent: r.filter((x) => x.status === "fulfilled").length, total: targets.length };
}
