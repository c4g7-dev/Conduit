import { NextResponse } from "next/server";
import { lpKnownPermissions } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Known permissions for editor autocomplete (stored + catalog + per-task bypass nodes). */
export async function GET() {
  try {
    return NextResponse.json({ permissions: await lpKnownPermissions() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
