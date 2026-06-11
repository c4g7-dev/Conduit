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
  });
}

/** { connectorTasks: [...] | null } — null/omitted-empty resets to the default (all). */
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
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
