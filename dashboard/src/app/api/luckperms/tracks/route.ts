import { NextRequest, NextResponse } from "next/server";
import { lpListTracks, lpSaveTrack, lpDeleteTrack, lpNetworkSync } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ tracks: await lpListTracks() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

/** Create/replace a track: { name, groups: ["vip","vipplus"] } (ordered low → high). */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    await lpSaveTrack(String(b.name ?? ""), Array.isArray(b.groups) ? b.groups : []);
    lpNetworkSync().catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const b = await req.json();
    await lpDeleteTrack(String(b.name ?? ""));
    lpNetworkSync().catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
