/**
 * File manager API for the shared store (/var/lib/conduit on GlusterFS) — templates,
 * tasks, assets. Proxies to a node agent's sandboxed /v1/fs. Per-service live files use
 * the existing /api/services/[vmid]/files route instead.
 */
import { NextRequest, NextResponse } from "next/server";
import { fsList, fsRead, fsWrite, fsMkdir, fsDelete } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const path = req.nextUrl.searchParams.get("path") ?? "";
    if (req.nextUrl.searchParams.get("file") === "1") {
      return NextResponse.json(await fsRead(path));
    }
    return NextResponse.json(await fsList(path));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { path, content } = (await req.json()) as { path?: string; content?: string };
    if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
    await fsWrite(path, content ?? "");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { action, path } = (await req.json()) as { action?: string; path?: string };
    if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
    if (action === "mkdir") await fsMkdir(path);
    else if (action === "delete") await fsDelete(path);
    else return NextResponse.json({ error: "bad action" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
