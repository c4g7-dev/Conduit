import { NextResponse } from "next/server";
import { api, lxcIp } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const resources = await api.clusterResources();
    const base = resources
      .filter((r) => r.type === "lxc")
      .sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0));

    const containers = await Promise.all(
      base.map(async (c) => ({
        vmid: c.vmid,
        name: c.name ?? `ct-${c.vmid}`,
        node: c.node,
        status: c.status ?? "unknown",
        cpu: c.cpu ?? 0,
        maxcpu: c.maxcpu ?? 0,
        mem: c.mem ?? 0,
        maxmem: c.maxmem ?? 0,
        maxdisk: c.maxdisk ?? 0,
        uptime: c.uptime ?? 0,
        tags: c.tags ?? "",
        pool: c.pool ?? "",
        template: c.template === 1,
        ip:
          c.status === "running" && c.vmid != null
            ? await lxcIp(c.vmid, c.node)
            : null,
      })),
    );

    return NextResponse.json({ containers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
