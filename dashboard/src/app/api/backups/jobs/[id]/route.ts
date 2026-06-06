import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await api.deleteBackupJob(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
