import { NextRequest, NextResponse } from "next/server";
import { mutate } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = await req.json();
    const updated = await mutate((d) => {
      const s = (d.schedules ?? []).find((x) => x.id === id);
      if (!s) throw new Error("not found");
      if (typeof b.enabled === "boolean") s.enabled = b.enabled;
      if (typeof b.name === "string") s.name = b.name;
      if (typeof b.at === "string" && /^\d{1,2}:\d{2}$/.test(b.at)) s.at = b.at;
      if (typeof b.command === "string") s.command = b.command;
      if (Array.isArray(b.warnMins)) s.warnMins = b.warnMins.map(Number).filter((n: number) => n > 0);
      return s;
    });
    return NextResponse.json({ schedule: updated });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await mutate((d) => { d.schedules = (d.schedules ?? []).filter((x) => x.id !== id); });
  return NextResponse.json({ ok: true });
}
