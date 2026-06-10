import { NextResponse } from "next/server";
import { versionStatuses } from "@/lib/version-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Per-task version status: pinned line, installed/latest build (hotfix), latest full version. */
export async function GET() {
  try {
    return NextResponse.json({ tasks: await versionStatuses() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
