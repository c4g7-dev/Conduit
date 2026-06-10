/** Connector plugin → graceful-shutdown deregistration, so the panel flips the service to
 *  "restarting…" instantly instead of waiting out the heartbeat-staleness window. */
import { NextRequest, NextResponse } from "next/server";
import { connectorAuthed } from "@/lib/connector-auth";
import { unregisterServer } from "@/lib/connector";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    unregisterServer(String(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
