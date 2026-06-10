import { NextRequest, NextResponse } from "next/server";
import { getDB, mutate, type Schedule, type ScheduleTarget } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function GET() {
  const db = await getDB();
  return NextResponse.json({ schedules: db.schedules ?? [] });
}

/** Validate + normalize one target object. */
function parseOne(t: Record<string, unknown> | undefined): ScheduleTarget | null {
  if (!t || typeof t.type !== "string") return null;
  if (t.type === "group" && typeof t.id === "string" && t.id) return { type: "group", id: t.id };
  if (t.type === "task" && typeof t.id === "string" && t.id) return { type: "task", id: t.id };
  if (t.type === "subgroup" && typeof t.id === "string" && typeof t.groupId === "string" && t.id && t.groupId)
    return { type: "subgroup", id: t.id, groupId: t.groupId };
  if (t.type === "instance" && Number.isFinite(Number(t.vmid))) return { type: "instance", vmid: Number(t.vmid) };
  return null;
}

/** Targets from the body: `targets[]` preferred, single `target` or legacy `groupId` accepted. */
function parseTargets(b: Record<string, unknown>): ScheduleTarget[] {
  if (Array.isArray(b.targets)) {
    return b.targets.map((t) => parseOne(t as Record<string, unknown>)).filter((t): t is ScheduleTarget => t !== null);
  }
  const one = parseOne(b.target as Record<string, unknown> | undefined);
  if (one) return [one];
  if (typeof b.groupId === "string" && b.groupId) return [{ type: "group", id: b.groupId }];
  return [];
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const name = String(b.name ?? "").trim();
    const at = String(b.at ?? "").trim();
    const action: Schedule["action"] =
      b.action === "command" ? "command" : b.action === "broadcast" ? "broadcast" : b.action === "backup" ? "backup" : "restart";
    const targets = parseTargets(b);
    if (!name || targets.length === 0 || !/^\d{1,2}:\d{2}$/.test(at)) {
      return NextResponse.json({ error: "name, at least one valid target and at (HH:MM) required" }, { status: 400 });
    }
    const sched: Schedule = {
      id: slug(`${name}-${Math.random().toString(36).slice(2, 6)}`),
      name, targets, action, at,
      command: action === "command" || action === "broadcast" ? String(b.command ?? "") : undefined,
      warnMins: Array.isArray(b.warnMins) ? b.warnMins.map(Number).filter((n: number) => n > 0) : (action === "restart" ? [5, 1] : []),
      onlyWhenEmpty: action === "restart" ? b.onlyWhenEmpty === true : undefined,
      backupStorage: action === "backup" ? String(b.backupStorage ?? "local") : undefined,
      enabled: b.enabled !== false,
    };
    await mutate((d) => { (d.schedules ??= []).push(sched); });
    return NextResponse.json({ schedule: sched });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
