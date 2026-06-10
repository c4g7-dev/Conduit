/**
 * In-game `/conduit maintenance <target> <on|off>` (the SUSI `/susigroups maintenance` model).
 * Token-authed (connector). `target` resolves case-insensitively against group ids/names,
 * subgroup ids/names, then task ids/names — first match wins, most-specific layer preferred
 * is NOT needed because ids are unique per layer in practice; ambiguity resolves group-first
 * so "network" hits the group, "timesmp" the subgroup, "world" the task.
 */
import { NextRequest, NextResponse } from "next/server";
import { mutate } from "@/lib/store";
import { connectorAuthed } from "@/lib/connector-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const target = String(b.target ?? "").trim().toLowerCase();
  const on = Boolean(b.on);
  if (!target) return NextResponse.json({ error: "target required" }, { status: 400 });

  const result = await mutate((db) => {
    const eq = (s: string | undefined) => (s ?? "").toLowerCase() === target;
    const g = db.groups.find((x) => eq(x.id) || eq(x.name));
    if (g) { g.maintenance = on; return { kind: "group", id: g.id, name: g.name, maintenance: on }; }
    for (const grp of db.groups) {
      const sg = grp.subgroups?.find((s) => eq(s.id) || eq(s.name));
      if (sg) { sg.maintenance = on; return { kind: "subgroup", id: sg.id, name: sg.name, maintenance: on }; }
    }
    const t = db.tasks.find((x) => eq(x.id) || eq(x.name));
    if (t) { t.maintenance = on; return { kind: "task", id: t.id, name: t.name, maintenance: on }; }
    throw new Error(`no group/subgroup/server named "${target}"`);
  }).catch((e) => ({ error: String(e) }));

  return NextResponse.json(result, { status: "error" in result ? 404 : 200 });
}
