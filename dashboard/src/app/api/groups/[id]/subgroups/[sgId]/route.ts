import { NextRequest, NextResponse } from "next/server";
import { mutate, type Subgroup } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; sgId: string }> };

/** Walk parentId links from `from`; true if `needle` appears (cycle guard for nesting). */
function inChain(all: Subgroup[], from: string | undefined, needle: string): boolean {
  let cur = from;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === needle) return true;
    cur = all.find((s) => s.id === cur)?.parentId;
  }
  return false;
}

export async function PATCH(req: NextRequest, ctx: Params) {
  const { id, sgId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const updated = await mutate((db) => {
    const g = db.groups.find((x) => x.id === id);
    const sg = g?.subgroups?.find((s) => s.id === sgId);
    if (!g || !sg) throw new Error("not found");
    if (typeof body.maintenance === "boolean") sg.maintenance = body.maintenance;
    if (typeof body.name === "string" && body.name.trim()) sg.name = body.name.trim();
    if (body.slotLimit !== undefined) {
      const n = Number(body.slotLimit);
      sg.slotLimit = Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
    }
    if (body.fullMessage !== undefined) {
      sg.fullMessage = typeof body.fullMessage === "string" && body.fullMessage.trim() ? body.fullMessage : undefined;
    }
    if (body.parentId !== undefined) {
      const pid = typeof body.parentId === "string" && body.parentId.trim() ? body.parentId.trim() : undefined;
      if (pid) {
        if (pid === sgId) throw new Error("a subgroup cannot be its own parent");
        if (!g.subgroups!.some((s) => s.id === pid)) throw new Error(`parent subgroup "${pid}" not found`);
        if (inChain(g.subgroups!, pid, sgId)) throw new Error("that would create a cycle");
      }
      sg.parentId = pid;
    }
    return sg;
  }).catch((e) => ({ error: String(e) }));
  return NextResponse.json(updated, { status: "error" in updated ? 400 : 200 });
}

export async function DELETE(_req: NextRequest, ctx: Params) {
  const { id, sgId } = await ctx.params;
  // Deleting a subgroup never touches instances — its tasks rejoin the group directly,
  // and any nested child subgroups move up to the deleted one's parent.
  const result = await mutate((db) => {
    const g = db.groups.find((x) => x.id === id);
    const sg = g?.subgroups?.find((s) => s.id === sgId);
    if (!g || !sg) throw new Error("not found");
    g.subgroups = g.subgroups!.filter((s) => s.id !== sgId);
    for (const child of g.subgroups) if (child.parentId === sgId) child.parentId = sg.parentId;
    for (const t of db.tasks) if (t.subgroupId === sgId && t.groupId === id) t.subgroupId = undefined;
    return { ok: true };
  }).catch((e) => ({ error: String(e) }));
  return NextResponse.json(result, { status: "error" in result ? 400 : 200 });
}
