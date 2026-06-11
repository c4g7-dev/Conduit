/** Network-wide managed settings: connector install set (+ LuckPerms set, read-only mirror). */
import { NextRequest, NextResponse } from "next/server";
import { getDB, mutate } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const db = await getDB();
  const n = db.network;
  return NextResponse.json({
    connectorTasks: n?.connectorTasks ?? null, // null = all paper/velocity/hytale (default)
    luckpermsTasks: n?.luckpermsTasks ?? [],
    invShareGroups: n?.invShareGroups ?? [],
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** { connectorTasks: [...] | null } and/or { invShareGroups: [{name,taskIds}] }. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    await mutate((d) => {
      d.network ??= { forwardingSecret: "" };
      if ("connectorTasks" in body) {
        d.network.connectorTasks = Array.isArray(body.connectorTasks) && body.connectorTasks.length
          ? body.connectorTasks.filter((x: unknown) => typeof x === "string")
          : undefined;
      }
      if (Array.isArray(body.invShareGroups)) {
        d.network.invShareGroups = body.invShareGroups
          .filter((g: { name?: unknown }) => typeof g.name === "string" && g.name.trim())
          .map((g: { id?: string; name: string; taskIds?: unknown }) => ({
            id: g.id || slug(g.name),
            name: g.name.trim(),
            taskIds: Array.isArray(g.taskIds) ? g.taskIds.filter((x: unknown) => typeof x === "string") : [],
          }));
      }
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
