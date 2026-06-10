/**
 * Player audit trail (DSGVO): query the per-day session/action log, and manage retention.
 *   GET  ?player=<name|uuid>&days=7  → entries (newest first) + retention setting
 *   POST { retentionDays }           → set the DSGVO retention window
 */
import { NextRequest, NextResponse } from "next/server";
import { queryAudit } from "@/lib/audit";
import { getDB, mutate } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const player = req.nextUrl.searchParams.get("player") ?? undefined;
    const days = Math.max(1, Math.min(90, Number(req.nextUrl.searchParams.get("days") ?? 7)));
    const db = await getDB();
    const entries = await queryAudit(player, days);
    return NextResponse.json({ entries, retentionDays: db.network?.auditRetentionDays ?? 30 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const days = Number(b.retentionDays);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return NextResponse.json({ error: "retentionDays must be 1–365" }, { status: 400 });
    }
    await mutate((d) => {
      if (d.network) d.network.auditRetentionDays = Math.round(days);
    });
    return NextResponse.json({ ok: true, retentionDays: Math.round(days) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
