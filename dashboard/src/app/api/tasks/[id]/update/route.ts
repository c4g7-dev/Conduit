/**
 * Apply a software update to a task's running instances.
 *   { } or { hotfix: true }      → latest build of the PINNED version line (hotfix)
 *   { version: "1.21.5" }        → switch the pinned line to a new full version (explicit only —
 *                                  never automatic) and install its latest build
 *   { autoUpdate: true|false }   → toggle auto-hotfix (applied by the reconcile loop)
 * Jar swap + restart per instance; world/config/plugins untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDB, mutate } from "@/lib/store";
import { blueprint, loadBlueprints } from "@/lib/blueprints";
import { discoverInstances, instancesOf } from "@/lib/engine";
import { applyJarUpdate } from "@/lib/provision";
import { jarFor, effectiveVersion } from "@/lib/version-status";
import { nodeIp } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    await loadBlueprints();
    const db = await getDB();
    const t = db.tasks.find((x) => x.id === id);
    if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });

    // toggle-only call
    if (typeof body.autoUpdate === "boolean" && body.version === undefined && !body.hotfix) {
      await mutate((d) => { const x = d.tasks.find((y) => y.id === id); if (x) x.autoUpdate = body.autoUpdate; });
      return NextResponse.json({ ok: true, autoUpdate: body.autoUpdate });
    }

    const { kind, version } = effectiveVersion(t);
    if (kind !== "paper" && kind !== "velocity") {
      return NextResponse.json({ error: `no update feed for ${kind}` }, { status: 400 });
    }
    const targetVersion = typeof body.version === "string" && body.version.trim() ? body.version.trim() : version;
    const jar = await jarFor(kind, targetVersion);

    const all = await discoverInstances();
    const results: { vmid: number; ok: boolean; error?: string }[] = [];
    for (const inst of instancesOf(all, t.id)) {
      if (inst.status !== "running" || !inst.ready) continue;
      try {
        await applyJarUpdate(inst.vmid, kind, jar.jarUrl, await nodeIp(inst.node));
        results.push({ vmid: inst.vmid, ok: true });
      } catch (e) {
        results.push({ vmid: inst.vmid, ok: false, error: String(e) });
      }
    }

    await mutate((d) => {
      const x = d.tasks.find((y) => y.id === id);
      if (!x) return;
      if (targetVersion !== version) {
        const bp = blueprint(x.blueprintId);
        x.software = { kind: (bp?.software.kind ?? kind) as typeof kind, version: targetVersion };
      }
      x.installedBuild = jar.build;
    });

    return NextResponse.json({ ok: true, version: targetVersion, build: jar.build, results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
