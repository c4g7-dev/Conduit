/**
 * Read-only file browser for a service's `/opt/mc` tree.
 *
 * Runs `ls`/`cat` inside the container from the Proxmox node:
 *   - GET ?path=/opt/mc           → directory listing [{name,type,size,mtime}]
 *   - GET ?path=...&file=1        → file contents (capped at ~256KB) for text view
 *
 * Sandboxed to within /opt/mc — any path that escapes (via `..`, or not rooted at
 * /opt/mc) is rejected. No write/delete (read-only for now).
 */
import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { nodeExec } from "@/lib/provision";
import { vmidHost } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROOT = "/opt/mc";
const MAX_BYTES = 256 * 1024;

/** Normalise + sandbox a requested path to within /opt/mc. Returns null if it escapes. */
function safePath(raw: string | null): string | null {
  const p = path.posix.normalize(raw && raw.trim() ? raw.trim() : ROOT);
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
      return NextResponse.json({ error: "path outside /opt/mc" }, { status: 400 });
    }
    const wantFile = req.nextUrl.searchParams.get("file") === "1";
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
