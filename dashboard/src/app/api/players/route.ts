/**
 * Network player list — sourced entirely from the connector (full list with UUIDs, per
 * server). SLP is gone; if no connector is reporting, the list is simply empty.
 */
import { NextResponse } from "next/server";
import { connectorActive, allPlayers, liveServers } from "@/lib/connector";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const players = allPlayers();
  const servers = liveServers();
  const proxyCap = servers.reduce((n, s) => n + (s.env === "proxy" ? s.max : 0), 0);
  return NextResponse.json({
    source: connectorActive() ? "connector" : "none",
    players,
    totals: { players: players.length, capacity: proxyCap || servers.reduce((n, s) => n + s.max, 0) },
  });
}
