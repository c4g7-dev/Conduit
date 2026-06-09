/** Migrate a container to another node (restart-migration; brief downtime). */
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/proxmox";
import { pushEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ vmid: string }> }) {
  try {
    const { vmid } = await ctx.params;
    const id = Number(vmid);
    const { target, node } = (await req.json()) as { target?: string; node?: string };
    if (!Number.isInteger(id) || !target) return NextResponse.json({ error: "vmid + target required" }, { status: 400 });
    if (target === node) return NextResponse.json({ error: "already on that node" }, { status: 400 });
    const upid = await api.migrateLxc(id, target, node);
    pushEvent(`↦ migrating ${id} → ${target}`);
    return NextResponse.json({ ok: true, upid });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
