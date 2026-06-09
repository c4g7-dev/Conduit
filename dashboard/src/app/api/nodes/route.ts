/** Cluster nodes (for deploy node-selection / instance pinning dropdowns). */
import { NextResponse } from "next/server";
import { api } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const nodes = await api.nodes();
    return NextResponse.json({ nodes: nodes.map((n) => ({ node: n.node, status: n.status })) });
  } catch (e) {
    return NextResponse.json({ error: String(e), nodes: [] }, { status: 502 });
  }
}
