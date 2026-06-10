import { NextRequest, NextResponse } from "next/server";
import { lpListUsers } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    return NextResponse.json({ users: await lpListUsers(q) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
