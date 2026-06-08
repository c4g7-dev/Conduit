/**
 * Panel → queue a player action (move/message/broadcast/kick) for the proxy plugin to run.
 * Falls back to nothing if no connector is active (caller can use console instead).
 */
import { NextRequest, NextResponse } from "next/server";
import { queueAction, connectorActive } from "@/lib/connector";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { kind?: string; player?: string; target?: string; text?: string; group?: string; reason?: string };
    if (!connectorActive()) return NextResponse.json({ error: "no connector active" }, { status: 409 });
    let id: number;
    switch (b.kind) {
      case "move": if (!b.player || !b.target) return NextResponse.json({ error: "player+target required" }, { status: 400 }); id = queueAction({ kind: "move", player: b.player, target: b.target }); break;
      case "message": if (!b.player || !b.text) return NextResponse.json({ error: "player+text required" }, { status: 400 }); id = queueAction({ kind: "message", player: b.player, text: b.text }); break;
      case "broadcast": if (!b.text) return NextResponse.json({ error: "text required" }, { status: 400 }); id = queueAction({ kind: "broadcast", group: b.group, text: b.text }); break;
      case "kick": if (!b.player) return NextResponse.json({ error: "player required" }, { status: 400 }); id = queueAction({ kind: "kick", player: b.player, reason: b.reason }); break;
      default: return NextResponse.json({ error: `bad kind: ${b.kind}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
