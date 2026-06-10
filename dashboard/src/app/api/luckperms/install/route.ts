import { NextResponse } from "next/server";
import { lpInstallAll } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Install/refresh LuckPerms on every running Paper/Velocity instance (restarts each). */
export async function POST() {
  try {
    const results = await lpInstallAll();
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
