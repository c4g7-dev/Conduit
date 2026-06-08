/** Read-only: live registered servers + flattened player list (for the panel/API). */
import { NextResponse } from "next/server";
import { liveServers, allPlayers, connectorActive } from "@/lib/connector";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ active: connectorActive(), servers: liveServers(), players: allPlayers() });
}
