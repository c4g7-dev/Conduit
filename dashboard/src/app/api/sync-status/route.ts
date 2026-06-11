/** Live template/overlay file-sync progress (manual re-sync + auto file-sync). */
import { NextResponse } from "next/server";
import { getSyncs } from "@/lib/sync-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ syncs: getSyncs() });
}
