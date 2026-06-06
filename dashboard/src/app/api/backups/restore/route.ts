import { NextRequest, NextResponse } from "next/server";
import { api, waitTask, NODE } from "@/lib/proxmox";
import { beginRestore, endRestore } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Restore a container from a backup snapshot — OVERWRITES the target vmid.
 * Stops the container (if running), restores the archive, then starts it again.
 * Holds the reconcile lock throughout so the controller doesn't race the restore.
 */
export async function POST(req: NextRequest) {
  beginRestore();
  try {
    const body = await req.json();
    const volid = String(body.volid ?? "");
    const vmid = Number(body.vmid ?? 0);
    if (!volid || !vmid)
      return NextResponse.json({ error: "volid and vmid required" }, { status: 400 });

    // stop the target (restore can't overwrite a running CT). Unconditional +
    // wait; stopping an already-stopped CT is a harmless error we ignore.
    const stop = await api.lxcAction(vmid, "stop").catch(() => null);
    if (stop) await waitTask(stop, NODE).catch(() => {});
    // small settle so the lock is fully released before overwrite
    await new Promise((r) => setTimeout(r, 1500));

    const upid = await api.restoreLxc(vmid, volid);
    await waitTask(upid, NODE, 300_000).catch(() => {});

    // bring it back up
    const start = await api.lxcAction(vmid, "start").catch(() => null);
    if (start) await waitTask(start, NODE).catch(() => {});

    return NextResponse.json({ upid });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  } finally {
    endRestore();
  }
}
