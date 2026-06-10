import { NextRequest, NextResponse } from "next/server";
import { mutate } from "@/lib/store";
import { decommissionTask } from "@/lib/engine";
import { api } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json();
  const updated = await mutate((db) => {
    const g = db.groups.find((x) => x.id === id);
    if (!g) throw new Error("not found");
    if (typeof body.maintenance === "boolean") g.maintenance = body.maintenance;
    if (typeof body.slotLimit === "number") g.slotLimit = body.slotLimit;
    if (typeof body.name === "string" && body.name.trim()) g.name = body.name.trim();
    if (body.fullMessage !== undefined) {
      g.fullMessage = typeof body.fullMessage === "string" && body.fullMessage.trim() ? body.fullMessage : undefined;
    }
    return g;
  }).catch((e) => ({ error: String(e) }));
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  // tear down all instances of all tasks in the group, then drop them
  const { tasks } = await mutate((db) => ({
    tasks: db.tasks.filter((t) => t.groupId === id).map((t) => t.id),
  }));
  for (const tid of tasks) await decommissionTask(tid).catch(() => {});
  await mutate((db) => {
    db.tasks = db.tasks.filter((t) => t.groupId !== id);
    db.groups = db.groups.filter((g) => g.id !== id);
  });
  await api.deletePool(id).catch(() => {});
  return NextResponse.json({ ok: true });
}
