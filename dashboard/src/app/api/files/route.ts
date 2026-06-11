/**
 * File manager API for the shared store (/var/lib/conduit on GlusterFS) — overlays,
 * tasks, assets, services. Proxies to a node agent's sandboxed /v1/fs.
 * GET ?download=1 streams a file (or zip of a dir) through the panel so the agent token
 * never reaches the browser.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  fsList, fsRead, fsWrite, fsMkdir, fsDelete, fsMove, fsCopy, fsUpload, fsArchive, fsExtract,
  fsDownloadResponse,
} from "@/lib/agent";
import { syncOnOverlayWrite } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Kick an instant templateSync for any overlay/task/_tpl path touched in the file manager. */
function kickSync(...paths: (string | undefined)[]) {
  for (const p of paths) if (p) syncOnOverlayWrite(p).catch(() => {});
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const path = sp.get("path") ?? "";
    if (sp.get("download") === "1") {
      const upstream = await fsDownloadResponse(path);
      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ error: `download ${upstream.status}` }, { status: 502 });
      }
      return new NextResponse(upstream.body, {
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
          "Content-Disposition": upstream.headers.get("content-disposition") ?? `attachment; filename="${path.split("/").pop() || "download"}"`,
        },
      });
    }
    if (sp.get("file") === "1") return NextResponse.json(await fsRead(path));
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
    kickSync(path);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const action = String(b.action ?? "");
    switch (action) {
      case "mkdir": await fsMkdir(String(b.path)); break;
      case "delete": await fsDelete((b.paths as string[]) ?? String(b.path)); break;
      case "move": await fsMove(String(b.from), String(b.to)); break;
      case "copy": await fsCopy(String(b.from), String(b.to)); break;
      case "upload": await fsUpload(String(b.dir), String(b.name), String(b.content)); break;
      case "archive": await fsArchive(String(b.dir), (b.names as string[]) ?? [], String(b.dest)); break;
      case "extract": await fsExtract(String(b.path)); break;
      default: return NextResponse.json({ error: `bad action: ${action}` }, { status: 400 });
    }
    // any mutation under an overlay dir re-syncs the affected services immediately
    kickSync(b.path as string | undefined, b.to as string | undefined, b.dir as string | undefined, ...((b.paths as string[]) ?? []));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
