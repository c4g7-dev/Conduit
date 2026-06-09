/**
 * Permanently delete a single instance (CT) and lower its task's target so the controller doesn't
 * re-provision it. This is the explicit operator delete — the only path that destroys a persistent
 * instance (auto-GC never touches those). Irreversible: the container + its disk are purged.
 */
import { NextRequest, NextResponse } from "next/server";
import { destroyInstance, reconcileAll } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ vmid: string }> }) {
  try {
    const { vmid } = await ctx.params;
    const taskId = await destroyInstance(Number(vmid));
    if (!taskId && taskId !== "") return NextResponse.json({ error: "not a Conduit instance" }, { status: 404 });
    reconcileAll().catch(() => {});
    return NextResponse.json({ ok: true, taskId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
