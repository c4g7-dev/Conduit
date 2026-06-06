import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Create a scheduled backup job for a pool (= Conduit group) → PBS storage. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const pool = String(body.pool ?? "");
    const storage = String(body.storage ?? "");
    const schedule = String(body.schedule ?? "02:00"); // systemd calendar (daily 02:00)
    if (!pool || !storage)
      return NextResponse.json({ error: "pool and storage required" }, { status: 400 });

    await api.createBackupJob({
      pool,
      storage,
      schedule,
      mode: "snapshot",
      compress: "zstd",
      enabled: 1,
      "notes-template": "conduit {{guestname}}",
      comment: `Conduit group ${pool}`,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
