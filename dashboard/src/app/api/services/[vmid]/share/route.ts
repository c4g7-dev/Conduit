/**
 * Apply the shared-store bind-mount (/opt/shared) to an existing service and relocate its
 * config/plugins onto the replicated store. Adds a Proxmox mountpoint, so the CT reboots
 * once. Used to retro-fit services created before the share mechanism existed.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/store";
import { blueprint, loadBlueprints } from "@/lib/blueprints";
import { discoverInstances } from "@/lib/engine";
import { vmidHost } from "@/lib/proxmox";
import { ensureServiceShare } from "@/lib/serviceshare";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ vmid: string }> }) {
  try {
    const { vmid } = await ctx.params;
    const id = Number(vmid);
    if (!Number.isInteger(id) || id < 200 || id > 999) {
      return NextResponse.json({ error: "invalid vmid" }, { status: 400 });
    }
    await loadBlueprints();
    const db = await getDB();
    const inst = (await discoverInstances()).find((i) => i.vmid === id);
    if (!inst) return NextResponse.json({ error: "instance not found" }, { status: 404 });
    const task = db.tasks.find((t) => t.id === inst.taskId);
    const bp = task ? blueprint(task.blueprintId) : undefined;
    const kind = (task?.software?.kind ?? bp?.software.kind) ?? "generic";

    const host = await vmidHost(id);
    await ensureServiceShare(id, kind, host);
    return NextResponse.json({ ok: true, vmid: id, kind });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
