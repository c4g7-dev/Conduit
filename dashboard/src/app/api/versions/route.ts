import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cache version lists briefly — they change rarely and the page polls.
let cache: Record<string, { at: number; versions: string[] }> = {};
const TTL = 10 * 60_000;

/**
 * Available versions for a software kind, for the New Task version picker.
 * paper/velocity come from the PaperMC API; others return a static hint.
 */
export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind") ?? "paper";

  if (kind !== "paper" && kind !== "velocity") {
    return NextResponse.json({ kind, versions: [] });
  }

  const hit = cache[kind];
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json({ kind, versions: hit.versions });

  try {
    // PaperMC v3 "Fill" API — v2 is frozen and misses newer MC versions.
    const res = await fetch(`https://fill.papermc.io/v3/projects/${kind}/versions`, {
      headers: { accept: "application/json" },
    });
    const json = await res.json();
    // already newest-first; cap the list
    const versions: string[] = (json.versions ?? [])
      .map((v: { version?: { id?: string } }) => v.version?.id)
      .filter(Boolean)
      .slice(0, 30);
    cache[kind] = { at: Date.now(), versions };
    return NextResponse.json({ kind, versions });
  } catch (e) {
    return NextResponse.json({ kind, versions: [], error: String(e) }, { status: 502 });
  }
}
