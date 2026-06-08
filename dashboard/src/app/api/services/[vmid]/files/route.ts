/**
 * Read-only file browser for a service's `/opt` tree.
 *
 * Runs `ls`/`cat` inside the container from the Proxmox node:
 *   - GET ?path=/opt/mc           → directory listing [{name,type,size,mtime}]
 *   - GET ?path=...&file=1        → file contents (capped at ~256KB) for text view
 *
 * Sandboxed to within /opt — covers every template's service dir (/opt/mc,
 * /opt/hytale, …). Any path that escapes (via `..`, or not rooted at /opt) is
 * rejected. No write/delete restrictions beyond the sandbox.
 */
import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { nodeExec } from "@/lib/provision";
import { vmidHost } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROOT = "/opt";
const DEFAULT_PATH = "/opt/mc";
const MAX_BYTES = 256 * 1024;

/** Normalise + sandbox a requested path to within /opt. Returns null if it escapes. */
function safePath(raw: string | null): string | null {
  const p = path.posix.normalize(raw && raw.trim() ? raw.trim() : DEFAULT_PATH);
  if (p !== ROOT && !p.startsWith(`${ROOT}/`)) return null;
  if (p.split("/").includes("..")) return null;
  return p;
}

type Entry = { name: string; type: "dir" | "file" | "link"; size: number; mtime: number };

/** Parse `ls -la --time-style=+%s` output into structured entries. */
function parseLs(out: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim() || line.startsWith("total ")) continue;
    // perms links owner group size mtime name
    const m = line.match(/^([dl\-rwxsStT.+]{10,})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, perms, size, mtime, rawName] = m;
    // drop "." and ".."; strip the "name -> target" suffix for symlinks
    const name = perms[0] === "l" ? rawName.split(" -> ")[0] : rawName;
    if (name === "." || name === "..") continue;
    const type: Entry["type"] = perms[0] === "d" ? "dir" : perms[0] === "l" ? "link" : "file";
    entries.push({ name, type, size: Number(size), mtime: Number(mtime) });
  }
  // dirs first, then alphabetical
  entries.sort(
    (a, b) =>
      Number(b.type === "dir") - Number(a.type === "dir") ||
      a.name.localeCompare(b.name),
  );
  return entries;
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ vmid: string }> },
) {
  try {
    const { vmid } = await ctx.params;
    const id = Number(vmid);
    if (!Number.isInteger(id) || id < 200 || id > 999)
      return NextResponse.json({ error: "invalid vmid" }, { status: 400 });

    const body = (await req.json()) as { path?: string; content?: string };
    const target = safePath(body.path ?? null);
    if (!target)
      return NextResponse.json({ error: "path outside /opt" }, { status: 400 });
    if (typeof body.content !== "string")
      return NextResponse.json({ error: "content required" }, { status: 400 });

    const b64Path = Buffer.from(target, "utf8").toString("base64");
    const b64Content = Buffer.from(body.content, "utf8").toString("base64");
    const host = await vmidHost(id);

    await nodeExec(
      `pct exec ${id} -- bash -c 'p="$(echo ${b64Path} | base64 -d)"; echo ${b64Content} | base64 -d > "$p"'`,
      30_000,
      host,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

const DOWNLOAD_MAX = 100 * 1024 * 1024; // base64-over-exec cap for per-service downloads
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** File operations inside a container (mkdir/delete/move/copy/upload/archive/extract). */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ vmid: string }> },
) {
  try {
    const { vmid } = await ctx.params;
    const id = Number(vmid);
    if (!Number.isInteger(id) || id < 200 || id > 999)
      return NextResponse.json({ error: "invalid vmid" }, { status: 400 });
    const b = (await req.json()) as Record<string, unknown>;
    const action = String(b.action ?? "");
    const host = await vmidHost(id);
    const sp = (v: unknown) => safePath(String(v ?? ""));

    let cmd: string | null = null;
    if (action === "mkdir") { const p = sp(b.path); if (p) cmd = `mkdir -p ${q(p)}`; }
    else if (action === "delete") {
      const list = Array.isArray(b.paths) ? b.paths : [b.path];
      const safe = list.map(sp).filter((p): p is string => !!p && p !== ROOT);
      if (safe.length) cmd = `rm -rf ${safe.map(q).join(" ")}`;
    }
    else if (action === "move" || action === "copy") {
      const from = sp(b.from), to = sp(b.to);
      if (from && to) cmd = `mkdir -p "$(dirname ${q(to)})" && ${action === "move" ? "mv" : "cp -r"} ${q(from)} ${q(to)}`;
    }
    else if (action === "upload") {
      const dir = sp(b.dir); const name = String(b.name ?? "").replace(/[/\\]/g, "");
      if (dir && name) {
        const cb64 = Buffer.from(String(b.content ?? ""), "base64").toString("base64"); // already b64 from client
        cmd = `mkdir -p ${q(dir)} && echo ${cb64} | base64 -d > ${q(`${dir}/${name}`)}`;
      }
    }
    else if (action === "archive") {
      const dir = sp(b.dir), dest = sp(b.dest); const names = (b.names as string[]) ?? [];
      if (dir && dest && names.length) cmd = `cd ${q(dir)} && zip -r -q ${q(dest)} ${names.map((n) => q(String(n).replace(/[/\\]/g, ""))).join(" ")}`;
    }
    else if (action === "extract") {
      const p = sp(b.path);
      if (p) cmd = /\.zip$/i.test(p) ? `unzip -o -q ${q(p)} -d "$(dirname ${q(p)})"` : `tar xf ${q(p)} -C "$(dirname ${q(p)})"`;
    }
    if (!cmd) return NextResponse.json({ error: `bad action/args: ${action}` }, { status: 400 });

    const b64 = Buffer.from(cmd, "utf8").toString("base64");
    await nodeExec(`pct exec ${id} -- bash -c 'echo ${b64} | base64 -d | bash'`, 300_000, host);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ vmid: string }> },
) {
  try {
    const { vmid } = await ctx.params;
    const id = Number(vmid);
    if (!Number.isInteger(id) || id < 200 || id > 999) {
      return NextResponse.json({ error: "invalid vmid" }, { status: 400 });
    }

    const target = safePath(req.nextUrl.searchParams.get("path"));
    if (!target) {
      return NextResponse.json({ error: "path outside /opt" }, { status: 400 });
    }
    const wantFile = req.nextUrl.searchParams.get("file") === "1";
    const wantDownload = req.nextUrl.searchParams.get("download") === "1";

    if (wantDownload) {
      const host = await vmidHost(id);
      const tb64 = Buffer.from(target, "utf8").toString("base64");
      // file → base64 it; dir → zip then base64 (capped). Heavy but fine for configs/plugins.
      const out = await nodeExec(
        `pct exec ${id} -- bash -c 'p="$(echo ${tb64} | base64 -d)"; if [ -d "$p" ]; then (cd "$(dirname "$p")" && zip -r -q - "$(basename "$p")") | base64; else head -c ${DOWNLOAD_MAX + 1} "$p" | base64; fi'`,
        300_000, host,
      );
      const buf = Buffer.from(out.replace(/\s+/g, ""), "base64");
      if (buf.length > DOWNLOAD_MAX) return NextResponse.json({ error: "file too large to download here — use SFTP" }, { status: 413 });
      const isDir = !target.includes(".") || false;
      const fname = target.split("/").pop() || "download";
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          "Content-Type": isDir ? "application/zip" : "application/octet-stream",
          "Content-Disposition": `attachment; filename="${fname}${isDir ? ".zip" : ""}"`,
        },
      });
    }
    const b64Path = Buffer.from(target, "utf8").toString("base64");
    const host = await vmidHost(id);

    if (wantFile) {
      // head -c caps the read; mark truncation when the file is larger.
      const content = await nodeExec(
        `pct exec ${id} -- bash -c 'p="$(echo ${b64Path} | base64 -d)"; head -c ${MAX_BYTES} "$p"'`,
        30_000,
        host,
      );
      const sizeRaw = await nodeExec(
        `pct exec ${id} -- bash -c 'p="$(echo ${b64Path} | base64 -d)"; stat -c %s "$p" 2>/dev/null || echo 0'`,
        15_000,
        host,
      ).catch(() => "0");
      const size = Number(sizeRaw.trim()) || content.length;
      return NextResponse.json({
        path: target,
        content,
        truncated: size > MAX_BYTES,
        size,
      });
    }

    const out = await nodeExec(
      `pct exec ${id} -- bash -c 'p="$(echo ${b64Path} | base64 -d)"; ls -la --time-style=+%s "$p"'`,
      20_000,
      host,
    );
    return NextResponse.json({ path: target, entries: parseLs(out) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
