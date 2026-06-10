import { NextRequest, NextResponse } from "next/server";
import { mutate } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; sgId: string }> };

export async function PATCH(req: NextRequest, ctx: Params) {
  const { id, sgId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const updated = await mutate((db) => {
    const g = db.groups.find((x) => x.id === id);
    const sg = g?.subgroups?.find((s) => s.id === sgId);
    if (!sg) throw new Error("not found");
    if (typeof body.maintenance === "boolean") sg.maintenance = body.maintenance;
    if (typeof body.name === "string" && body.name.trim()) sg.name = body.name.trim();
    return sg;
  }).catch((e) => ({ error: String(e) }));
  return NextResponse.json(updated, { status: "error" in updated ? 400 : 200 });
}

export async function DELETE(_req: NextRequest, ctx: Params) {
  const { id, sgId } = await ctx.params;
  // Deleting a subgroup never touches instances — its tasks just rejoin the group directly.
  const result = await mutate((db) => {
    const g = db.groups.find((x) => x.id === id);
    if (!g?.subgroups?.some((s) => s.id === sgId)) throw new Error("not found");
    g.subgroups = g.subgroups.filter((s) => s.id !== sgId);
    for (const t of db.tasks) if (t.subgroupId === sgId && t.groupId === id) t.subgroupId = undefined;
    return { ok: true };
  }).catch((e) => ({ error: String(e) }));
  return NextResponse.json(result, { status: "error" in result ? 400 : 200 });
}
