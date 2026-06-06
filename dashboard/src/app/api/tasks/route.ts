import { NextRequest, NextResponse } from "next/server";
import { mutate, slug, type Task } from "@/lib/store";
import { blueprint } from "@/lib/blueprints";
import { reconcileAll } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const groupId = String(body.groupId ?? "");
    const bp = blueprint(String(body.blueprintId ?? ""));
    if (!name || !groupId || !bp) {
      return NextResponse.json(
        { error: "name, groupId and a valid blueprintId are required" },
        { status: 400 },
      );
    }

    const id = slug(`${groupId}-${name}`);
    const mode: "dynamic" | "static" = body.mode ?? bp.mode;
    const min = Number(body.min ?? 1);
    const initialDesired = Number(body.desired ?? min);
    // dynamic tasks autoscale by default and need an upper cap; static run a fixed count
    const autoscale = body.autoscale ?? mode === "dynamic";

    const task: Task = {
      id,
      name,
      groupId,
      blueprintId: bp.id,
      mode,
      desired: Math.max(min, initialDesired),
      min,
      max: Number(body.max ?? (mode === "dynamic" ? 5 : initialDesired)),
      autoscale,
      playersPerInstance: Number(body.playersPerInstance ?? (bp.role === "lobby" ? 50 : 80)),
      cores: Number(body.cores ?? bp.cores),
      memory: Number(body.memory ?? bp.memory),
      disk: Number(body.disk ?? bp.disk),
      persistent: body.persistent ?? bp.persistent,
      fronts: Array.isArray(body.fronts) ? body.fronts : [],
      seed: body.seed && typeof body.seed === "object" ? body.seed : undefined,
      createdAt: Date.now(),
    };

    const created = await mutate((db) => {
      if (!db.groups.some((g) => g.id === groupId)) throw new Error("group not found");
      if (db.tasks.some((t) => t.id === id)) throw new Error("task exists");
      db.tasks.push(task);
      return task;
    });

    // kick a reconcile so instances start coming up immediately
    reconcileAll().catch(() => {});
    return NextResponse.json({ task: created });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
