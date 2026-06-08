/**
 * Server-side network operations reused by API routes and the scheduler:
 * broadcasting a console command to a group, and restarting a group's instances.
 * Uses the node agent (local pct exec) when available, else SSH — same path as the
 * single-server console.
 */
import { getDB } from "./store";
import { discoverInstances } from "./engine";
import { nodeExec } from "./provision";
import { vmidHost } from "./proxmox";
import { agentUp, agentExec } from "./agent";

async function instancesForGroup(groupId: string) {
  const db = await getDB();
  const taskIds = new Set(db.tasks.filter((t) => t.groupId === groupId).map((t) => t.id));
  return (await discoverInstances()).filter(
    (i) => i.taskId && taskIds.has(i.taskId) && i.status === "running",
  );
}

/** Send one console command into a container's tmux session. */
async function sendKeys(vmid: number, command: string) {
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
