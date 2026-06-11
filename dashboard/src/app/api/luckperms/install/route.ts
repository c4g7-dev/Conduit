import { NextRequest, NextResponse } from "next/server";
import { lpInstallAll } from "@/lib/luckperms";
import { getDB, mutate } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // current managed LuckPerms set (task ids)
  const db = await getDB();
  return NextResponse.json({ taskIds: db.network?.luckpermsTasks ?? [] });
}

/**
 * Set the managed LuckPerms set and install it.
 *   { taskIds: [...] } → persist the set; install on those services (reconcile keeps it synced).
 *   no body            → install on the existing set (or all Paper/Velocity if none configured).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    let set: string[] | undefined;
    if (Array.isArray(body.taskIds)) {
      set = body.taskIds.filter((x: unknown) => typeof x === "string");
      await mutate((d) => { (d.network ??= { forwardingSecret: "" }).luckpermsTasks = set; });
    } else {
      const db = await getDB();
      set = db.network?.luckpermsTasks?.length ? db.network.luckpermsTasks : undefined;
    }
    const results = await lpInstallAll(set, true);
    return NextResponse.json({ results, taskIds: set ?? null });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
