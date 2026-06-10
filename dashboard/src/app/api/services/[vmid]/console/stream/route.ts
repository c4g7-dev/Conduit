/**
 * SSE console stream.
 *
 * Preferred path: proxy the Conduit node agent's real-time WebSocket. The agent
 * uses tmux pipe-pane + tail -F, so output is genuinely pushed (no polling) and
 * reaches the browser in ~1 network hop. Each agent frame is re-emitted as an SSE
 * `data:` line carrying base64(pane text) — the same format the browser parses.
 *
 * Fallback path (agent down): the legacy SSH capture-pane poll loop.
 *
 * Latency aids for the fallback:
 *  - SSH ControlMaster (provision.ts) reuses the session (~5 ms/hop).
 *  - consoleTriggers: a sent command makes the loop skip its sleep.
 */
import { NextRequest } from "next/server";
import { nodeExec } from "@/lib/provision";
import { vmidHost } from "@/lib/proxmox";
import { consoleTriggers } from "@/lib/console-triggers";
import { agentUp, agentConsole } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_MS = 100;
const POST_CMD_POLLS = 6;

const IDLE_MSG = Buffer.from(
  "[console] no tmux session — container may still be provisioning or stopped.",
).toString("base64");

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ vmid: string }> },
) {
  const { vmid } = await ctx.params;
  const id = Number(vmid);
  if (!Number.isInteger(id) || id < 200 || id > 999) {
    return new Response("bad vmid", { status: 400 });
  }

  let host: string;
  try {
    host = await vmidHost(id);
  } catch {
    return new Response("container not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  req.signal.addEventListener("abort", () => { closed = true; });

  const useAgent = await agentUp(host);

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      const emit = (text: string) => {
        const b64 = Buffer.from(text, "utf8").toString("base64");
        try { controller.enqueue(encoder.encode(`data: ${b64}\n\n`)); return true; }
        catch { return false; }
      };

      if (useAgent) {
        // ----- agent WebSocket proxy (real-time) -----
        // The agent sends a `history` snapshot then incremental `output` chunks.
        // We accumulate into a rolling buffer so the browser always shows full context.
        let buf = "";
        const conn = agentConsole(host, id, {
          onFrame: (frame) => {
            if (frame.type === "history") {
              buf = String(frame.data ?? "");
              emit(buf);
            } else if (frame.type === "output") {
              buf += String(frame.data ?? "");
              // cap buffer so it doesn't grow unbounded over long sessions
              if (buf.length > 200_000) buf = buf.slice(-160_000);
              emit(buf);
            }
          },
          onClose: () => { if (!closed) emit("\n[console] agent stream closed\n"); },
        });

        // Keep the response open until the client disconnects.
        while (!closed) await sleep(500);
        conn.close();
        try { controller.close(); } catch { /* gone */ }
        return;
      }

      // ----- SSH polling fallback -----
      let lastSig = "";
      let lastTrigger = consoleTriggers.get(id) ?? 0;
      let fastPolls = 0;

      while (!closed) {
        const currentTrigger = consoleTriggers.get(id) ?? 0;
        if (currentTrigger !== lastTrigger) {
          lastTrigger = currentTrigger;
          fastPolls = POST_CMD_POLLS;
        }

        let text: string;
        try {
          text = await nodeExec(
            `pct exec ${id} -- tmux -L mc capture-pane -p -e -t mc -S -200`,
            8_000,
            host,
          );
        } catch {
          text = "";
        }
        const b64 = text ? Buffer.from(text, "utf8").toString("base64") : IDLE_MSG;

        if (b64 !== lastSig) {
          lastSig = b64;
          try { controller.enqueue(encoder.encode(`data: ${b64}\n\n`)); }
          catch { break; }
        }

        if (fastPolls > 0) fastPolls--;
        else await sleep(POLL_MS);
      }

      try { controller.close(); } catch { /* gone */ }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
