import { NextResponse } from "next/server";
import { getHistory, pushSample, type Sample } from "@/lib/history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Time-series buffer for the Overview charts.
 *
 * Client-push model: the Overview page POSTs the current totals each poll tick
 * ({ players, cpu, mem }); we append a timestamped sample. GET returns the
 * whole ring buffer for rendering.
 */
export async function GET() {
  return NextResponse.json({ samples: getHistory() });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<Sample>;
    const sample: Sample = {
      t: Date.now(),
      players: num(body.players),
      cpu: clamp01(num(body.cpu)),
      mem: clamp01(num(body.mem)),
    };
    pushSample(sample);
    return NextResponse.json({ ok: true, samples: getHistory().length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
