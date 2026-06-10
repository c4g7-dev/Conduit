import { NextResponse } from "next/server";
import { getDB } from "@/lib/store";
import { blueprint, loadBlueprints } from "@/lib/blueprints";
import { discoverInstances } from "@/lib/engine";
import { connServersByVmid } from "@/lib/metrics-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live player metrics for every Conduit-managed instance — sourced from the connector
 * registry (the plugin reports exact counts + full player lists). SLP is gone. Non-MC roles
 * (db/generic/hytale) report no players; liveness comes from the connector heartbeat for MC
 * and Proxmox running-state otherwise.
 */
export async function GET() {
  try {
    await loadBlueprints();
    const db = await getDB();
    const instances = (await discoverInstances()).filter(
      (i) => i.status === "running" && i.ip,
    );
    const conn = connServersByVmid();

    const rows = instances.map((i) => {
      const task = db.tasks.find((t) => t.id === i.taskId);
      const bp = task ? blueprint(task.blueprintId) : undefined;
      const role = bp?.role ?? "generic";
      const port = bp?.port ?? 25565;
      const s = conn.get(i.vmid);
      return {
        vmid: i.vmid,
        taskId: i.taskId,
        taskName: task?.name ?? i.taskId,
        role,
        ip: i.ip,
        port,
        reachable: !!s,
        online: s?.online ?? 0,
        max: s?.max ?? 0,
        sample: (s?.players ?? []).map((p) => p.name),
        tps: s?.tps,
        version: "",
        latencyMs: 0,
      };
    });

    // Network player count = what the edge proxies report (avoids double-counting a player
    // on both proxy and backend). Fall back to backends when no proxy is reporting.
    const proxies = rows.filter((r) => r.role === "proxy" && r.reachable);
    const backends = rows.filter((r) => r.role !== "proxy" && r.reachable);
    const players = (proxies.length ? proxies : backends).reduce((n, r) => n + r.online, 0);
    const capacity = (proxies.length ? proxies : backends).reduce((n, r) => n + r.max, 0);

    return NextResponse.json({
      instances: rows,
      totals: {
        players,
        capacity,
        proxies: proxies.length,
        backends: backends.length,
        reachable: rows.filter((r) => r.reachable).length,
        instances: rows.length,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
