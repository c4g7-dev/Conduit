/**
 * Network player list. Prefers the connector's full list (name+UUID, per server); falls
 * back to Minecraft SLP samples (capped ~12/server) when no connector is reporting.
 */
import { NextResponse } from "next/server";
import { connectorActive, allPlayers, liveServers } from "@/lib/connector";
import { getDB } from "@/lib/store";
import { blueprint, loadBlueprints } from "@/lib/blueprints";
import { discoverInstances } from "@/lib/engine";
import { pingMc } from "@/lib/mcping";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    if (connectorActive()) {
      const players = allPlayers();
      const servers = liveServers();
      return NextResponse.json({
        source: "connector",
        players,
        totals: { players: players.length, capacity: servers.reduce((n, s) => n + (s.env === "proxy" ? s.max : 0), 0) || servers.reduce((n, s) => n + s.max, 0) },
      });
    }
    // SLP fallback
    await loadBlueprints();
    const db = await getDB();
    const insts = (await discoverInstances()).filter((i) => i.status === "running" && i.ip);
    const rows = await Promise.all(insts.map(async (i) => {
      const t = db.tasks.find((x) => x.id === i.taskId);
      const bp = t ? blueprint(t.blueprintId) : undefined;
      const role = bp?.role ?? "generic";
      if (role === "db" || role === "generic") return null;
      try { const p = await pingMc(i.ip!, bp?.port ?? 25565); return { role, taskName: t?.name ?? i.taskId, sample: p.sample, online: p.online }; }
      catch { return null; }
    }));
    const players: { name: string; server: string }[] = [];
    for (const r of rows) if (r && r.role !== "proxy") for (const s of r.sample) players.push({ name: s.name, server: r.taskName });
    return NextResponse.json({ source: "slp", players, totals: { players: players.length, capacity: 0 } });
  } catch (e) {
    return NextResponse.json({ error: String(e), players: [] }, { status: 502 });
  }
}
