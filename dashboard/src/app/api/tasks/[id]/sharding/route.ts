/**
 * Live world-sharding view for a task: its sharding config + the computed strip grid (regions,
 * per-world X-ranges, border) with each region's current online count merged in. Drives the
 * region-grid visualization on the World tab.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/store";
import { gridForTask } from "@/lib/shard-state";
import { liveServers } from "@/lib/connector";
import { enableShardingWithSeed, reconcileAll } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Enable sharding on the task: apply a shared seed to every region instance and regenerate their
 * worlds (DESTRUCTIVE — operator-approved via the UI warning). Body: { seed?: string } (empty =
 * auto-generate). Returns the seed used + how many instances were regenerated.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const r = await enableShardingWithSeed(id, typeof body.seed === "string" ? body.seed : undefined);
    reconcileAll().catch(() => {});
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

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
