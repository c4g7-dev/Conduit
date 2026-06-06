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

    const cts = resources.filter((r) => r.type === "lxc");
    const vms = resources.filter((r) => r.type === "qemu");
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
