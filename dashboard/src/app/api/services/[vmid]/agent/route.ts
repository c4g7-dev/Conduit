/**
 * Resolve which node agent hosts a container, so the browser terminal can open a
 * WebSocket to the console proxy with the right target agent. The agent token is
 * never exposed — the proxy injects it server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { vmidHost } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ vmid: string }> },
) {
  try {
    const { vmid } = await ctx.params;
    const id = Number(vmid);
    if (!Number.isInteger(id) || id < 200 || id > 999) {
      return NextResponse.json({ error: "invalid vmid" }, { status: 400 });
    }
    const host = await vmidHost(id);
    const consolePort = Number(process.env.CONDUIT_CONSOLE_PORT || 8801);
    return NextResponse.json({ agent: host, consolePort });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
