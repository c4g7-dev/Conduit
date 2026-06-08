/** Connector plugin → register a service on enable. */
import { NextRequest, NextResponse } from "next/server";
import { registerServer } from "@/lib/connector";
import { connectorAuthed } from "@/lib/connector-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    registerServer(b);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
