/**
 * Broadcast a console command to every running instance of every server in a group.
 * Used for network-wide ops: `say <msg>`, `save-all`, restart warnings, etc.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/store";
import { broadcastToGroup } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { command } = (await req.json()) as { command?: string };
    if (typeof command !== "string" || !command.trim()) {
      return NextResponse.json({ error: "command required" }, { status: 400 });
    }
    const db = await getDB();
    if (!db.groups.some((g) => g.id === id)) {
      return NextResponse.json({ error: "group not found" }, { status: 404 });
    }
    const { sent, total } = await broadcastToGroup(id, command);
    return NextResponse.json({ ok: true, sent, total });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
