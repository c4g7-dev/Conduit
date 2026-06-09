import { NextResponse } from "next/server";
import { api, type ClusterResource } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const [nodes, resources] = await Promise.all([
      api.nodes(),
      api.clusterResources(),
    ]);

    // Exclude templates (golden images are stopped LXCs but not real servers) — they were
    // inflating the "Containers running/total" tile (e.g. 11/14 when only 11 actually run).
    const cts = resources.filter((r) => r.type === "lxc" && r.template !== 1);
    const vms = resources.filter((r) => r.type === "qemu" && r.template !== 1);
    const guests = [...cts, ...vms];

    const sum = (xs: ClusterResource[], k: keyof ClusterResource) =>
      xs.reduce((a, r) => a + (Number(r[k]) || 0), 0);

    return NextResponse.json({
      nodes: nodes.map((n) => ({
        node: n.node,
        status: n.status,
        cpu: n.cpu ?? 0,
        maxcpu: n.maxcpu ?? 0,
        mem: n.mem ?? 0,
        maxmem: n.maxmem ?? 0,
        uptime: n.uptime ?? 0,
      })),
      totals: {
        nodes: nodes.length,
        nodesOnline: nodes.filter((n) => n.status === "online").length,
        containers: cts.length,
        containersRunning: cts.filter((c) => c.status === "running").length,
        vms: vms.length,
        memUsed: sum(guests, "mem"),
        memMax: sum(nodes as unknown as ClusterResource[], "maxmem"),
        playersOnline: 0, // placeholder until Velocity bridge is wired
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
