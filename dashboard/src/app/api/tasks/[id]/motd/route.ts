import { NextRequest, NextResponse } from "next/server";
import { mutate } from "@/lib/store";
import { blueprint, loadBlueprints } from "@/lib/blueprints";
import { discoverInstances, instancesOf, reconcileAll } from "@/lib/engine";
import { setMotd, forgetVelocity } from "@/lib/provision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Set a task's MOTD and apply it live to every ready instance (no reinstall). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { motd } = await req.json();
    const text = String(motd ?? "");

    const task = await mutate((db) => {
      const t = db.tasks.find((x) => x.id === id);
      if (!t) throw new Error("task not found");
      t.motd = text;
      return t;
    });

    await loadBlueprints();
    const role = blueprint(task.blueprintId)?.role ?? "generic";
    const all = await discoverInstances();
    const ready = instancesOf(all, id).filter((i) => i.status === "running" && i.ready);

    if (role === "proxy") {
      // Regenerate the whole velocity.toml (motd lives there) — drop the cached
      // signature so the next reconcile rewrites + restarts the proxy.
      ready.forEach((i) => forgetVelocity(i.vmid));
      await reconcileAll();
      return NextResponse.json({ ok: true, applied: ready.length, instances: ready.length });
    }

    // Paper: patch the motd line in server.properties and restart, in parallel.
    const results = await Promise.allSettled(ready.map((i) => setMotd(i.vmid, role, text)));
    const applied = results.filter((r) => r.status === "fulfilled").length;
    return NextResponse.json({ ok: true, applied, instances: ready.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
