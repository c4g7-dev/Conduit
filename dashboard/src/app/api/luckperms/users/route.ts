import { NextRequest, NextResponse } from "next/server";
import { lpListUsers } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    // ?all=1 → the full roster (View all); default keeps the rail snappy with a short list
    const all = req.nextUrl.searchParams.get("all") === "1";
    const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "");
    const limit = all ? 1000 : Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
    return NextResponse.json({ users: await lpListUsers(q, limit) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
