/**
 * Live world-sharding view for a task: its sharding config + the computed strip grid (regions,
 * per-world X-ranges, border) with each region's current online count merged in. Drives the
 * region-grid visualization on the World tab.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/store";
import { gridForTask } from "@/lib/shard-state";
import { liveServers } from "@/lib/connector";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDB();
  const task = db.tasks.find((t) => t.id === id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });

  const grid = gridForTask(task);
  const byId = new Map(liveServers().map((s) => [s.id, s]));
  const regions = (grid?.regions ?? []).map((r) => {
    const s = byId.get(r.serverId);
    return { ...r, online: s?.online ?? 0, max: s?.max ?? 0, reachable: !!s };
  });

  return NextResponse.json({
    sharding: task.sharding ?? null,
    grid: grid ? { ...grid, regions } : null,
  });
}
