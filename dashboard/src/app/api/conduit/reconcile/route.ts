import { NextResponse } from "next/server";
import { reconcileAll } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    const log = await reconcileAll();
    return NextResponse.json({ log });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
