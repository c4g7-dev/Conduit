import { NextRequest, NextResponse } from "next/server";
import { getDB, mutate, type Schedule } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function GET() {
  const db = await getDB();
  return NextResponse.json({ schedules: db.schedules ?? [] });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const name = String(b.name ?? "").trim();
    const groupId = String(b.groupId ?? "");
    const action = b.action === "broadcast" ? "broadcast" : "restart";
    const at = String(b.at ?? "").trim();
    if (!name || !groupId || !/^\d{1,2}:\d{2}$/.test(at)) {
      return NextResponse.json({ error: "name, groupId and at (HH:MM) required" }, { status: 400 });
    }
    const sched: Schedule = {
      id: slug(`${name}-${Math.random().toString(36).slice(2, 6)}`),
      name, groupId, action, at,
      command: action === "broadcast" ? String(b.command ?? "") : undefined,
      warnMins: Array.isArray(b.warnMins) ? b.warnMins.map(Number).filter((n: number) => n > 0) : (action === "restart" ? [5, 1] : []),
      enabled: b.enabled !== false,
    };
    await mutate((d) => { (d.schedules ??= []).push(sched); });
    return NextResponse.json({ schedule: sched });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
