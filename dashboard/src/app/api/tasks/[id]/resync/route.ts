/**
 * Re-apply a task's overlay chain (overlays/_global/<kind> + overlays/<egg> + tasks/<task>)
 * to its running instances and restart them — the manual "rewrite from template" action.
 * ?restart=0 applies files without restarting (configs picked up on next natural restart).
 */
import { NextRequest, NextResponse } from "next/server";
import { resyncTaskFiles } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const restart = req.nextUrl.searchParams.get("restart") !== "0";
    const results = await resyncTaskFiles(id, restart);
    return NextResponse.json({ ok: true, restart, results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
