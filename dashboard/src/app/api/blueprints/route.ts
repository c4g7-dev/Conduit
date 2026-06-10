import { NextRequest, NextResponse } from "next/server";
import { loadBlueprints, allBlueprints, BUILTIN_IDS, type Blueprint, type Role, type SoftwareKind } from "@/lib/blueprints";
import { mutate, slug } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await loadBlueprints();
  return NextResponse.json({ blueprints: allBlueprints(), builtin: [...BUILTIN_IDS] });
}

const ROLES: Role[] = ["proxy", "lobby", "smp", "db", "generic"];
const KINDS: SoftwareKind[] = ["paper", "velocity", "mariadb", "hytale", "generic"];
const DEBIAN = "local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst";

/** Create a custom template (stored in the JSON store, merged with built-ins). */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const name = String(b.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const id = slug(b.id ? String(b.id) : name);
    if (BUILTIN_IDS.has(id))
      return NextResponse.json({ error: `'${id}' is a built-in template` }, { status: 400 });

    const role: Role = ROLES.includes(b.role) ? b.role : "generic";
    const kind: SoftwareKind = KINDS.includes(b.software?.kind) ? b.software.kind : "generic";
    const bp: Blueprint = {
      id,
      name,
      role,
      mode: b.mode === "dynamic" ? "dynamic" : "static",
      persistent: b.persistent ?? role !== "lobby",
      base: String(b.base || DEBIAN),
      cores: Number(b.cores ?? 2),
      memory: Number(b.memory ?? 2048),
      disk: Number(b.disk ?? 8),
      port: Number(b.port ?? 25565),
      description: String(b.description ?? "Custom template"),
      longDescription: b.longDescription ? String(b.longDescription) : undefined,
      provision: String(b.provision ?? `${kind} (custom)`),
      software: { kind, version: String(b.software?.version ?? "latest") },
      sharedAssets: Boolean(b.sharedAssets),
      seed: b.seed && typeof b.seed === "object" ? b.seed : undefined,
      // Custom provisioning recipe (generic templates): packages / assets / install / start.
      custom: b.custom && typeof b.custom === "object" ? {
        packages: b.custom.packages ? String(b.custom.packages) : undefined,
        assets: Array.isArray(b.custom.assets)
          ? b.custom.assets.filter((a: { url?: string; dest?: string }) => a?.url && a?.dest)
              .map((a: { url: string; dest: string }) => ({ url: String(a.url), dest: String(a.dest) }))
          : undefined,
        installScript: b.custom.installScript ? String(b.custom.installScript) : undefined,
        startCommand: b.custom.startCommand ? String(b.custom.startCommand) : undefined,
      } : undefined,
    };

    await mutate((db) => {
      db.blueprints = db.blueprints ?? [];
      if (db.blueprints.some((x) => x.id === id)) throw new Error("template exists");
      db.blueprints.push(bp);
    });
    return NextResponse.json({ blueprint: bp });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
