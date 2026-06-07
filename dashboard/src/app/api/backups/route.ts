import { NextRequest, NextResponse } from "next/server";
import { api, waitTask } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Storages + recent snapshots + scheduled jobs — the Backups dashboard feed. */
export async function GET() {
  try {
    const [storagesRaw, jobs, resources] = await Promise.all([
      api.backupStorages(),
      api.backupJobs().catch(() => []),
      api.clusterResources().catch(() => []),
    ]);
    // stable order — Proxmox returns storages in arbitrary order, which made the
    // dashboard cards swap positions on each poll.
    const storages = [...storagesRaw].sort((a, b) => a.storage.localeCompare(b.storage));
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

    const sortedJobs = [...jobs].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    return NextResponse.json({ storages, backups, jobs: sortedJobs });
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

/** Delete a single backup snapshot. */
export async function DELETE(req: NextRequest) {
  try {
    const volid = req.nextUrl.searchParams.get("volid") ?? "";
    const storage = req.nextUrl.searchParams.get("storage") ?? "";
    if (!volid || !storage)
      return NextResponse.json({ error: "volid and storage required" }, { status: 400 });
    await api.deleteBackup(storage, volid);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
