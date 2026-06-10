/**
 * Subgroups (Untergruppen) of a group — named, addressable buckets of tasks so ops like
 * maintenance can target e.g. just `timesmp` without touching the rest of the network.
 */
import { NextRequest, NextResponse } from "next/server";
import { mutate, slug } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const created = await mutate((db) => {
    const g = db.groups.find((x) => x.id === id);
    if (!g) throw new Error("group not found");
    g.subgroups ??= [];
    const sgId = slug(name);
    if (!sgId) throw new Error("invalid name");
    if (g.subgroups.some((s) => s.id === sgId)) throw new Error(`subgroup "${sgId}" already exists`);
    const sg = { id: sgId, name, maintenance: false, createdAt: Date.now() };
    g.subgroups.push(sg);
    return sg;
  }).catch((e) => ({ error: String(e) }));

  return NextResponse.json(created, { status: "error" in created ? 400 : 200 });
}
