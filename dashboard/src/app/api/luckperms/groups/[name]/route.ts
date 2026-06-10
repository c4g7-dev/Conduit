import { NextRequest, NextResponse } from "next/server";
import { lpGroupNodes, lpDeleteGroup, lpAddNode, lpRemoveNode, lpNetworkSync } from "@/lib/luckperms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, ctx: Params) {
  try {
    const { name } = await ctx.params;
    return NextResponse.json({ nodes: await lpGroupNodes(name) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

/** Add a node: { permission, value?, server?, world?, expiry? } */
export async function POST(req: NextRequest, ctx: Params) {
  try {
    const { name } = await ctx.params;
    const b = await req.json();
    if (!b.permission) throw new Error("permission required");
    await lpAddNode({ type: "group", id: name }, b);
    lpNetworkSync().catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

/** Remove a node (body: { permission, server?, world? }) — or the whole group with ?group=1. */
export async function DELETE(req: NextRequest, ctx: Params) {
  try {
    const { name } = await ctx.params;
    if (req.nextUrl.searchParams.get("group") === "1") {
      await lpDeleteGroup(name);
    } else {
      const b = await req.json();
      if (!b.permission) throw new Error("permission required");
      await lpRemoveNode({ type: "group", id: name }, b);
    }
    lpNetworkSync().catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
