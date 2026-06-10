/**
 * Live connector stream (SSE). Pushes the same payload as /api/connector/servers
 * ({ active, servers, players }) to the browser the moment it changes, so the Players page (and
 * anything else) reflects joins/quits/kicks/moves instantly instead of waiting for a 5s poll.
 *
 * Implementation: the connector registry is in-memory on this process, so we cheaply diff a
 * signature of it every 500ms and emit only on change (plus a keep-alive comment). No Proxmox or
 * agent calls — this is pure local state, so a tight interval is fine.
 */
import { NextRequest } from "next/server";
import { liveServers, allPlayers, connectorActive } from "@/lib/connector";
import { lpSignature } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function snapshot(lpSig: string | null) {
  const servers = liveServers().map((s) => ({
    id: s.id, task: s.task, group: s.group, env: s.env,
    online: s.online, max: s.max, tps: s.tps,
    players: s.players, queues: s.queues, lastSeen: s.lastSeen,
  }));
  return { active: connectorActive(), servers, players: allPlayers(), lpSig };
}

/** Compact change signature — ids, counts, queue sizes, the flattened player set, and the
 *  LuckPerms data hash (so the permissions editor live-updates on any change network-wide). */
function sig(snap: ReturnType<typeof snapshot>): string {
  return snap.servers.map((s) =>
    `${s.id}:${s.online}/${s.max}:${(s.queues ?? []).map((q) => `${q.id}=${q.players.length}`).join("+")}`,
  ).sort().join(",")
    + "|" + snap.players.map((p) => `${p.name}@${p.server}`).sort().join(",")
    + "|" + (snap.lpSig ?? "");
}

export async function GET(req: NextRequest) {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let last = "";
      let lpSig: string | null = null;
      const tick = () => {
        try {
          // lpSignature() self-caches ~3s and refreshes async — never blocks the 500ms loop.
          lpSignature().then((s) => { lpSig = s; }).catch(() => {});
          const snap = snapshot(lpSig);
          const s = sig(snap);
          if (s !== last) { last = s; send(snap); }
          else controller.enqueue(enc.encode(": keep-alive\n\n"));
        } catch { /* controller closed */ }
      };
      tick(); // emit current state immediately on connect
      timer = setInterval(tick, 500);
      req.signal.addEventListener("abort", () => { if (timer) clearInterval(timer); try { controller.close(); } catch {} });
    },
    cancel() { if (timer) clearInterval(timer); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
