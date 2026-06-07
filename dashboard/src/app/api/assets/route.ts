import { NextRequest, NextResponse } from "next/server";
import { listAssets, putAsset, deleteAsset } from "@/lib/assets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ assets: await listAssets() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

/** Upload an asset (multipart form: file, kind). */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const kind = String(form.get("kind") ?? "worlds");
    if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > 512 * 1024 * 1024)
      return NextResponse.json({ error: "file too large (max 512MB)" }, { status: 400 });
    const asset = await putAsset(kind, file.name, buf);
    return NextResponse.json({ asset });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const rel = req.nextUrl.searchParams.get("path") ?? "";
    await deleteAsset(rel);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
