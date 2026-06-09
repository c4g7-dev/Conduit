/**
 * Compatible move targets for a player — the services they can be sent to. Same game kind only
 * (paper↔paper, hytale↔hytale), proxies excluded, and the player's current instance excluded.
 * Returns each target's encoded action `target`:
 *   paper  → the velocity server name "<task>-<vmid>" (proxy resolves it via bestByPrefix)
 *   hytale → "hyt:<ip>:<port>" (the Hytale connector referToServers it)
 *
 *   GET /api/connector/move-targets?server=<taskName>&group=<groupId>&vmid=<currentVmid>
 */
import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/store";
import { blueprint, loadBlueprints } from "@/lib/blueprints";
import { discoverInstances } from "@/lib/engine";
import { connServersByVmid } from "@/lib/metrics-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const velocityName = (task: string, vmid: number) =>
  `${task.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}-${vmid}`;

export async function GET(req: NextRequest) {
  await loadBlueprints();
  const db = await getDB();
  const server = req.nextUrl.searchParams.get("server") ?? "";
  const group = req.nextUrl.searchParams.get("group") ?? "";
  const excludeVmid = Number(req.nextUrl.searchParams.get("vmid") ?? 0);

  const task = db.tasks.find((t) => t.name === server && (!group || t.groupId === group))
    ?? db.tasks.find((t) => t.name === server);
  const kind = task ? blueprint(task.blueprintId)?.software.kind : undefined;
  // Only game servers can be moved between; proxies/db/web aren't valid targets or sources.
  if (!kind || (kind !== "paper" && kind !== "hytale")) return NextResponse.json({ kind: kind ?? null, targets: [] });

  const insts = (await discoverInstances().catch(() => [])).filter((i) => i.status === "running");
  const byVmid = connServersByVmid();
  const targets = [];
  for (const inst of insts) {
    if (inst.vmid === excludeVmid) continue;
    const itask = db.tasks.find((t) => t.id === inst.taskId);
    if (!itask) continue;
    const ibp = blueprint(itask.blueprintId);
    if (!ibp || ibp.software.kind !== kind) continue; // same game kind only (proxies excluded)
    const conn = byVmid.get(inst.vmid);
    targets.push({
      vmid: inst.vmid,
      task: itask.name,
      label: `${itask.name}-${inst.vmid}`,
      node: inst.node,
      online: conn?.online ?? 0,
      max: conn?.max ?? 0,
      target: kind === "hytale" ? `hyt:${inst.ip}:${ibp.port}` : velocityName(itask.name, inst.vmid),
    });
  }
  targets.sort((a, b) => a.label.localeCompare(b.label));
  return NextResponse.json({ kind, targets });
}
