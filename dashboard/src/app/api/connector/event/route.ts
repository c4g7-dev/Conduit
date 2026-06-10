/** Connector plugin → join/quit/switch events, surfaced in the Activity feed. */
import { NextRequest, NextResponse } from "next/server";
import { connectorAuthed } from "@/lib/connector-auth";
import { pushEvent } from "@/lib/events";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { type, player, server } = await req.json();
    if (type === "join") pushEvent(`▸ ${player} joined ${server ?? "network"}`);
    else if (type === "quit") pushEvent(`◂ ${player} left ${server ?? "network"}`);
    else if (type === "switch") pushEvent(`↷ ${player} → ${server}`);
    // player audit trail (DSGVO-retained day files on the shared store)
    if (type === "join" || type === "quit" || type === "switch") {
      recordAudit({ type, player: String(player ?? "?"), server: server ?? undefined, actor: "player" });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
