/**
 * Connector plugin → periodic heartbeat with full player list + counts (+ TPS).
 * The proxy heartbeat also receives any pending actions to execute (move/message/kick).
 */
import { NextRequest, NextResponse } from "next/server";
import { heartbeat, drainActions } from "@/lib/connector";
import { connectorAuthed } from "@/lib/connector-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    heartbeat(b.id, b);
    // Proxies poll for actions to run; backends just report.
    const actions = b.env === "proxy" ? drainActions(Number(b.ackActionId ?? 0)) : [];
    return NextResponse.json({ ok: true, actions });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
