/** DSGVO right-to-erasure: remove every audit entry of a player (by name or uuid). */
import { NextRequest, NextResponse } from "next/server";
import { erasePlayerAudit } from "@/lib/audit";
import { pushEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const player = String(b.player ?? "").trim();
    if (!player) return NextResponse.json({ error: "player required" }, { status: 400 });
    const { removed } = await erasePlayerAudit(player);
    pushEvent(`history erasure: removed ${removed} entr${removed === 1 ? "y" : "ies"} for "${player}"`, "warn");
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
