/**
 * Named generic file templates (ideas.md §2): create a template with a name, pick which
 * services receive it. Files live at overlays/_tpl/<id>/ on the shared store; the overlay
 * chain applies them to every member task (egg < _global/<kind> < named templates < task).
 */
import { NextRequest, NextResponse } from "next/server";
import { getDB, mutate, slug } from "@/lib/store";
import { ensureGlobalTemplateDir } from "@/lib/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const db = await getDB();
  return NextResponse.json({ templates: db.globalTemplates ?? [] });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const id = slug(name);
  if (!id) return NextResponse.json({ error: "invalid name" }, { status: 400 });

  const created = await mutate((db) => {
    db.globalTemplates ??= [];
    if (db.globalTemplates.some((t) => t.id === id)) throw new Error(`template "${id}" already exists`);
    const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((x: unknown) => typeof x === "string") : [];
    const tpl = { id, name, taskIds, createdAt: Date.now() };
    db.globalTemplates.push(tpl);
    return tpl;
  }).catch((e) => ({ error: String(e) }));
  if ("error" in created) return NextResponse.json(created, { status: 400 });

  await ensureGlobalTemplateDir(id).catch(() => {});
  return NextResponse.json(created);
}
