import { NextRequest, NextResponse } from "next/server";
import { BUILTIN_IDS } from "@/lib/blueprints";
import { getDB, mutate } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Delete a custom template (built-ins can't be removed; refuse if a task uses it). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (BUILTIN_IDS.has(id))
    return NextResponse.json({ error: "built-in template" }, { status: 400 });

  const db = await getDB();
  if (db.tasks.some((t) => t.blueprintId === id))
    return NextResponse.json({ error: "template in use by a task" }, { status: 400 });

  await mutate((d) => {
    d.blueprints = (d.blueprints ?? []).filter((b) => b.id !== id);
  });
  return NextResponse.json({ ok: true });
}
