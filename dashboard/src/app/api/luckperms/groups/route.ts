import { NextRequest, NextResponse } from "next/server";
import { lpListGroups, lpCreateGroup, lpNetworkSync } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ groups: await lpListGroups() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    await lpCreateGroup(String(b.name ?? ""));
    lpNetworkSync().catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
