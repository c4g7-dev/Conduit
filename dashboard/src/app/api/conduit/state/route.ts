import { NextResponse } from "next/server";
import { getDB } from "@/lib/store";
import { blueprint, allBlueprints, loadBlueprints, isSystemKind } from "@/lib/blueprints";
import { discoverInstances, instancesOf, routingTables } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await loadBlueprints();
    const db = await getDB();
    const instances = await discoverInstances();

    const groups = db.groups.map((g) => {
      const tasks = db.tasks
        .filter((t) => t.groupId === g.id)
        .map((t) => {
          const bp = blueprint(t.blueprintId);
          const insts = instancesOf(instances, t.id);
          return {
            ...t,
            role: bp?.role ?? "generic",
            blueprintName: bp?.name ?? t.blueprintId,
            port: bp?.port ?? 25565,
            softwareKind: bp?.software.kind ?? "generic",
            system: isSystemKind(bp?.software.kind),
            version: t.software?.version ?? bp?.software.version ?? "",
            motd: t.motd ?? "",
            instances: insts,
            live: insts.length,
            running: insts.filter((i) => i.status === "running").length,
          };
        });
      return { ...g, tasks };
    });

    const routing = await routingTables();

    return NextResponse.json({ groups, routing, blueprints: allBlueprints() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
