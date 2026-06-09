import { NextRequest, NextResponse } from "next/server";
import { mutate } from "@/lib/store";
import { decommissionTask, reconcileAll } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();

    const updated = await mutate((db) => {
      const t = db.tasks.find((x) => x.id === id);
      if (!t) throw new Error("not found");

      // scale: set desired directly or by delta
      if (typeof body.desired === "number") t.desired = body.desired;
      if (typeof body.delta === "number") t.desired = t.desired + body.delta;

      if (typeof body.min === "number") t.min = body.min;
      if (typeof body.max === "number") t.max = body.max;
      if (Array.isArray(body.fronts)) t.fronts = body.fronts;
      if (typeof body.autoscale === "boolean") t.autoscale = body.autoscale;
      if (typeof body.playersPerInstance === "number") t.playersPerInstance = body.playersPerInstance;
      // CloudNet Smart-style autoscaling knobs
      if (typeof body.preparedPool === "number") t.preparedPool = body.preparedPool;
      if (typeof body.scaleUpPercent === "number") t.scaleUpPercent = body.scaleUpPercent;
      if (typeof body.scaleDownAfterSec === "number") t.scaleDownAfterSec = body.scaleDownAfterSec;
      if (typeof body.spawnCooldownSec === "number") t.spawnCooldownSec = body.spawnCooldownSec;
      if (typeof body.maxServices === "number") t.maxServices = body.maxServices;
      if (typeof body.splitOverNodes === "boolean") t.splitOverNodes = body.splitOverNodes;
      if (body.node !== undefined) t.node = (typeof body.node === "string" && body.node.trim()) ? body.node.trim() : undefined;

      // resources: only affect newly provisioned instances (existing LXCs aren't resized)
      if (typeof body.cores === "number") t.cores = body.cores;
      if (typeof body.memory === "number") t.memory = body.memory;
      if (typeof body.disk === "number") t.disk = body.disk;

      // seed: world URL + plugin list (applied on next fresh provision)
      if (body.seed !== undefined) {
        if (body.seed === null) {
          t.seed = undefined;
        } else {
          t.seed = {
            worldUrl: typeof body.seed.worldUrl === "string" ? body.seed.worldUrl || undefined : t.seed?.worldUrl,
            plugins: Array.isArray(body.seed.plugins) ? body.seed.plugins.filter(Boolean) : t.seed?.plugins,
            icon: typeof body.seed.icon === "string" ? body.seed.icon || undefined : t.seed?.icon,
            properties: body.seed.properties && typeof body.seed.properties === "object" ? body.seed.properties : t.seed?.properties,
          };
        }
      }

      // clamp desired into [min, max||∞] after any min/max change
      t.desired = Math.max(t.min, t.max > 0 ? Math.min(t.desired, t.max) : t.desired);
      return t;
    });

    reconcileAll().catch(() => {});
    return NextResponse.json({ task: updated });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  await decommissionTask(id).catch(() => {});
  await mutate((db) => {
    db.tasks = db.tasks.filter((t) => t.id !== id);
  });
  return NextResponse.json({ ok: true });
}
