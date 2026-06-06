import { NextResponse } from "next/server";
import { api } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const [templates, storage] = await Promise.all([
      api.templates().catch(() => []),
      api.storage().catch(() => []),
    ]);

    return NextResponse.json({
      templates: templates.map((t) => {
        // local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst
        const file = t.volid.split("/").pop() ?? t.volid;
        const os = file.split("_")[0];
        return { volid: t.volid, file, os, size: t.size ?? 0, format: t.format ?? "" };
      }),
      storage: storage.map((s) => ({
        storage: s.storage,
        type: s.type,
        content: s.content,
        avail: s.avail ?? 0,
        used: s.used ?? 0,
        total: s.total ?? 0,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
