/**
 * Per-service console bridge.
 *
 * The MC server runs inside a tmux session `mc` (socket `-L mc`) created by the
 * systemd unit (see provision.ts). We drive it from the Proxmox node via
 * `pct exec <vmid> -- tmux …`:
 *   - GET  → capture the last 200 lines of the pane (read-only console tail)
 *   - POST → send a command line into the session ({ command })
 *
 * Read-only / best-effort: if the session isn't up yet we return a friendly
 * message rather than a 500 so the UI can keep polling.
 */
import { NextRequest, NextResponse } from "next/server";
import { nodeExec } from "@/lib/provision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NOT_READY =
  "[console] no tmux session yet — the service may still be provisioning or stopped.";

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
    try {
      const lines = await nodeExec(
        `pct exec ${id} -- tmux -L mc capture-pane -p -t mc -S -200`,
        20_000,
      );
      return NextResponse.json({ lines });
    } catch {
      // tmux missing / session not created / container stopped → not an error
      return NextResponse.json({ lines: NOT_READY });
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ vmid: string }> },
) {
  try {
    const { vmid } = await ctx.params;
    const id = Number(vmid);
    if (!Number.isInteger(id) || id < 200 || id > 999) {
      return NextResponse.json({ error: "invalid vmid" }, { status: 400 });
    }
    const { command } = (await req.json()) as { command?: string };
    if (typeof command !== "string" || command.trim() === "") {
      return NextResponse.json({ error: "command required" }, { status: 400 });
    }
    // Strip any literal newlines (one command per send) and base64-pipe the line
    // so arbitrary quoting/special chars survive the SSH + pct exec hops safely.
    const line = command.replace(/[\r\n]+/g, " ").trim();
    const b64 = Buffer.from(line, "utf8").toString("base64");
    // Decode inside the container into a tmux send-keys literal, then press Enter.
    await nodeExec(
      `pct exec ${id} -- bash -c 'tmux -L mc send-keys -t mc "$(echo ${b64} | base64 -d)" Enter'`,
      20_000,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
