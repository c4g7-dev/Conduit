/**
 * Sharding handoff: a backend connector reports that a player crossed its strip boundary into
 * another region. We stash the player's exact coords for the destination instance (applied on
 * join) and queue a proxy `move` to connect them there — the Conduit-native CST equivalent.
 *
 *   { player, target, targetServerId, loc }
 *   target          velocity server name of the owning region (e.g. "world-203")
 *   targetServerId  its connector id (e.g. "network-world-203") — pending coords are keyed by this
 *   loc             "x;y;z;world;yaw;pitch" to restore on the destination
 */
import { NextRequest, NextResponse } from "next/server";
import { connectorAuthed } from "@/lib/connector-auth";
import { queueAction, connectorActive } from "@/lib/connector";
import { recordTransfer } from "@/lib/shard-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!connectorAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const b = (await req.json()) as { player?: string; target?: string; targetServerId?: string; loc?: string };
    if (!b.player || !b.target || !b.targetServerId || !b.loc)
      return NextResponse.json({ error: "player+target+targetServerId+loc required" }, { status: 400 });
    if (!connectorActive()) return NextResponse.json({ error: "no connector active" }, { status: 409 });
    recordTransfer(b.targetServerId, b.player, b.loc);
    const id = queueAction({ kind: "move", player: b.player, target: b.target });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
