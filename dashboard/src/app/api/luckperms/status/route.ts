import { NextResponse } from "next/server";
import { lpStatus } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await lpStatus());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
