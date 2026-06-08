/**
 * Activity feed + derived health alerts.
 * Events come from the engine's reconcile log (provision/scale/GC/errors).
 * Alerts are derived live from instance state: a desired-but-stopped instance, or a
 * running instance that's been un-ready (still installing) — surfaced as warnings.
 */
import { NextResponse } from "next/server";
import { getEvents } from "@/lib/events";
import { getDB } from "@/lib/store";
import { discoverInstances } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const db = await getDB();
    const all = await discoverInstances();
    const taskById = new Map(db.tasks.map((t) => [t.id, t]));

    const alerts: { level: "warn" | "error"; msg: string; vmid?: number }[] = [];
    for (const i of all) {
      const t = i.taskId ? taskById.get(i.taskId) : undefined;
      const label = `${t?.name ?? i.taskId ?? i.name} #${i.vmid}`;
      if (i.status !== "running" && t) {
        alerts.push({ level: "error", msg: `${label} is ${i.status} (expected running)`, vmid: i.vmid });
      } else if (i.status === "running" && i.ready === false) {
        alerts.push({ level: "warn", msg: `${label} is still provisioning / not ready`, vmid: i.vmid });
      }
    }

    return NextResponse.json({ events: getEvents().slice(-150).reverse(), alerts });
  } catch (e) {
    return NextResponse.json({ error: String(e), events: [], alerts: [] }, { status: 502 });
  }
}
