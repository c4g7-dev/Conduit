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

      // scale: set desired directly or by delta, clamped to [min, max||∞]
      if (typeof body.desired === "number") t.desired = body.desired;
      if (typeof body.delta === "number") t.desired = t.desired + body.delta;
      t.desired = Math.max(t.min, t.max > 0 ? Math.min(t.desired, t.max) : t.desired);

      if (typeof body.min === "number") t.min = body.min;
      if (typeof body.max === "number") t.max = body.max;
      if (Array.isArray(body.fronts)) t.fronts = body.fronts;
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
