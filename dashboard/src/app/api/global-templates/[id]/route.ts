import { NextRequest, NextResponse } from "next/server";
import { mutate } from "@/lib/store";
import { removeGlobalTemplateDir } from "@/lib/templates";
import { resyncTaskFiles } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Rename and/or set member services. ?apply=1 re-syncs files to affected tasks immediately. */
export async function PATCH(req: NextRequest, ctx: Params) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const result = await mutate((db) => {
    const tpl = db.globalTemplates?.find((t) => t.id === id);
    if (!tpl) throw new Error("not found");
    const before = new Set(tpl.taskIds);
    if (typeof body.name === "string" && body.name.trim()) tpl.name = body.name.trim();
    if (Array.isArray(body.taskIds)) tpl.taskIds = body.taskIds.filter((x: unknown) => typeof x === "string");
    // tasks whose membership flipped either way need a re-sync to gain/lose the files
    const affected = new Set<string>([...before, ...tpl.taskIds]);
    return { tpl, affected: [...affected] };
  }).catch((e) => ({ error: String(e) }));
  if ("error" in result) return NextResponse.json(result, { status: 400 });

  if (req.nextUrl.searchParams.get("apply") === "1") {
    for (const tid of result.affected) await resyncTaskFiles(tid, false).catch(() => {});
  }
  return NextResponse.json(result.tpl);
}

export async function DELETE(_req: NextRequest, ctx: Params) {
  const { id } = await ctx.params;
  const result = await mutate((db) => {
    if (!db.globalTemplates?.some((t) => t.id === id)) throw new Error("not found");
    db.globalTemplates = db.globalTemplates.filter((t) => t.id !== id);
    return { ok: true };
  }).catch((e) => ({ error: String(e) }));
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  await removeGlobalTemplateDir(id).catch(() => {});
  return NextResponse.json(result);
}
