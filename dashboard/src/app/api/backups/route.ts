import { NextRequest, NextResponse } from "next/server";
import { api, waitTask } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Storages + recent snapshots + scheduled jobs — the Backups dashboard feed. */
export async function GET() {
  try {
    const [storages, jobs, resources] = await Promise.all([
      api.backupStorages(),
      api.backupJobs().catch(() => []),
      api.clusterResources().catch(() => []),
    ]);
    const nameByVmid = new Map(
      resources.filter((r) => r.vmid != null).map((r) => [r.vmid as number, r.name ?? `ct-${r.vmid}`]),
    );

    const backups = (
      await Promise.all(
        storages.map((s) =>
          api
            .storageContent(s.storage)
            .then((items) => items.map((b) => ({ ...b, storage: s.storage })))
            .catch(() => []),
        ),
      )
    )
      .flat()
      .map((b) => ({
        volid: b.volid,
        storage: b.storage,
        vmid: b.vmid ?? null,
        name: b.vmid != null ? nameByVmid.get(b.vmid) ?? null : null,
        ctime: b.ctime ?? 0,
        size: b.size ?? 0,
        notes: b.notes ?? "",
      }))
      .sort((a, b) => b.ctime - a.ctime);

    return NextResponse.json({ storages, backups, jobs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

/** Trigger an immediate backup of a single container or a whole pool (group). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const storage = String(body.storage ?? "");
    if (!storage) return NextResponse.json({ error: "storage required" }, { status: 400 });

    const params: Record<string, string | number> = {
      storage,
      mode: "snapshot",
      compress: "zstd",
      "notes-template": "conduit {{guestname}}",
    };
    if (body.vmid != null) params.vmid = Number(body.vmid);
    else if (body.pool) params.pool = String(body.pool);
    else return NextResponse.json({ error: "vmid or pool required" }, { status: 400 });

    const upid = await api.vzdump(params);
    // don't block the request on the whole dump; just confirm it started
    waitTask(upid).catch(() => {});
    return NextResponse.json({ upid });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
