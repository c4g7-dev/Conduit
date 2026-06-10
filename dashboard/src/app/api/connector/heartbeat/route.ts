/**
 * Connector plugin → periodic heartbeat with full player list + counts (+ TPS).
 * The proxy heartbeat also receives any pending actions to execute (move/message/kick)
 * AND a `config` block (routing fallbacks, MOTD, maintenance, tablist) built from Conduit
 * state. Every heartbeat carries a light `names` snapshot for plugin tab-completion.
 */
import { NextRequest, NextResponse } from "next/server";
import { heartbeat, drainActions, liveServers, allPlayers } from "@/lib/connector";
import { connectorAuthed } from "@/lib/connector-auth";
import { buildProxyConfig } from "@/lib/proxy-config";
import { shardConfigForServer } from "@/lib/shard-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Light name snapshot for plugin tab-completion (server + player names). */
function nameSnapshot() {
  return {
    servers: liveServers().map((s) => s.id.replace(/^network-/, "")),
    players: allPlayers().map((p) => p.name),
  };
}

export async function POST(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    heartbeat(b.id, b);
    const names = nameSnapshot();
    if (b.env === "proxy") {
      const actions = drainActions(Number(b.ackActionId ?? 0));
      const config = await buildProxyConfig(String(b.task ?? ""), String(b.group ?? "")).catch(() => null);
      return NextResponse.json({ ok: true, actions, config, names });
    }
    // Hytale has no proxy, so its own connector drains + executes actions for its players
    // (move via referToServer / message / kick). MC backends never drain (the proxy does).
    if (b.env === "hytale") {
      const actions = drainActions(Number(b.ackActionId ?? 0));
      return NextResponse.json({ ok: true, actions, names });
    }
    // Backends: hand a sharded task's instance its strip grid + pending coord-restores.
    // Send `config: null` when not sharded so the connector clears any stale grid.
    const shard = await shardConfigForServer(String(b.id), String(b.task ?? ""), String(b.group ?? "")).catch(() => null);
    return NextResponse.json({ ok: true, actions: [], names, config: shard ? { sharding: shard } : null });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
