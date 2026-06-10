import { NextRequest, NextResponse } from "next/server";
import { lpUserNodes, lpAddNode, lpRemoveNode, lpSetPrimaryGroup, lpNetworkSync } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ uuid: string }> };

export async function GET(_req: NextRequest, ctx: Params) {
  try {
    const { uuid } = await ctx.params;
    return NextResponse.json(await lpUserNodes(uuid));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

/** Add a node, or set the primary group with { primaryGroup }. */
export async function POST(req: NextRequest, ctx: Params) {
  try {
    const { uuid } = await ctx.params;
    const b = await req.json();
    if (typeof b.primaryGroup === "string") {
      await lpSetPrimaryGroup(uuid, b.primaryGroup);
    } else {
      if (!b.permission) throw new Error("permission required");
      await lpAddNode({ type: "user", id: uuid }, b);
    }
    lpNetworkSync().catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, ctx: Params) {
  try {
    const { uuid } = await ctx.params;
    const b = await req.json();
    if (!b.permission) throw new Error("permission required");
    await lpRemoveNode({ type: "user", id: uuid }, b);
    lpNetworkSync().catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
