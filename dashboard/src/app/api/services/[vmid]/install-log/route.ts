/**
 * SSE endpoint that streams the in-memory provisioning log for a container.
 * Lines are captured from ctExec stdout during installPaper / installVelocity.
 * Polls the buffer every 500 ms; sends a full snapshot on first connect then diffs.
 */
import { NextRequest } from "next/server";
import { getInstallLog } from "@/lib/provision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

  const encoder = new TextEncoder();
  let closed = false;
  req.signal.addEventListener("abort", () => { closed = true; });

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));

      let sent = 0;
      while (!closed) {
        const lines = getInstallLog(id);
        if (lines.length > sent) {
          const newLines = lines.slice(sent);
          sent = lines.length;
          const payload = Buffer.from(newLines.join("\n"), "utf8").toString("base64");
          try {
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          } catch {
            break;
          }
        }
        await sleep(500);
      }

      try { controller.close(); } catch { /* already closed */ }
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
