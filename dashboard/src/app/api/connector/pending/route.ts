/**
 * Sharding: a destination connector fetches its pending coord-restores (snappy on player join,
 * so the handoff teleport happens immediately rather than waiting for the next heartbeat).
 *   GET /api/connector/pending?id=<self connector serverId>  → { pending: [{player, loc}] }
 */
import { NextRequest, NextResponse } from "next/server";
import { connectorAuthed } from "@/lib/connector-auth";
import { pendingForServer, clearPending } from "@/lib/shard-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ack = req.nextUrl.searchParams.get("ack");
  if (ack) { clearPending(id, ack.split(",").filter(Boolean)); return NextResponse.json({ ok: true }); }
  return NextResponse.json({ pending: pendingForServer(id) });
}
