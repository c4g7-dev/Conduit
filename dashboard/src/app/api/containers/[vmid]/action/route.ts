import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED = ["start", "stop", "shutdown", "reboot"] as const;
type Action = (typeof ALLOWED)[number];

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ vmid: string }> },
) {
  try {
    const { vmid } = await ctx.params;
    const { action, node } = (await req.json()) as { action: Action; node?: string };

    if (!ALLOWED.includes(action)) {
      return NextResponse.json({ error: `invalid action: ${action}` }, { status: 400 });
    }

    const upid = await api.lxcAction(Number(vmid), action, node);
    return NextResponse.json({ upid });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
