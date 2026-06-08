/**
 * Connector plugin → periodic heartbeat with full player list + counts (+ TPS).
 * The proxy heartbeat also receives any pending actions to execute (move/message/kick)
 * AND a `config` block (routing fallbacks, MOTD, maintenance, tablist) built from Conduit
 * state — so the plugin stays generic and behaviour is configured server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { heartbeat, drainActions } from "@/lib/connector";
import { connectorAuthed } from "@/lib/connector-auth";
import { buildProxyConfig } from "@/lib/proxy-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    heartbeat(b.id, b);
    if (b.env === "proxy") {
      const actions = drainActions(Number(b.ackActionId ?? 0));
      const config = await buildProxyConfig(String(b.task ?? ""), String(b.group ?? "")).catch(() => null);
      return NextResponse.json({ ok: true, actions, config });
    }
    return NextResponse.json({ ok: true, actions: [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
