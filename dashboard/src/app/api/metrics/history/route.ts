import { NextRequest, NextResponse } from "next/server";
import { getHistory, pushSample, type Sample } from "@/lib/history";
import { api, vmidNode } from "@/lib/proxmox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Metrics history.
 *
 * Two modes:
 *  • `?range=5m|1h|24h|30d` (+ optional `vmid`) — Proxmox RRD time-series (cpu %, mem %), the
 *    real historical data straight from Proxmox, cached server-side (RRD only refreshes ~1/min).
 *    No vmid → cluster aggregate across all nodes. With vmid → that container.
 *  • no query — the legacy client-pushed ring buffer of network totals (the Overview's live 5m
 *    players/cpu/mem line); POST appends to it.
 */

// range → Proxmox RRD timeframe + trailing points to keep (RRD "hour" is ~70 pts @1min).
const RANGE: Record<string, { tf: string; keep?: number }> = {
  "5m": { tf: "hour", keep: 7 },
  "1h": { tf: "hour" },
  "24h": { tf: "day" },
  "30d": { tf: "month" },
};

type Pt = { t: number; cpu: number; mem: number; memBytes: number; maxmemBytes: number; netin: number; netout: number };

// tiny server-side cache (key → {at, data}); RRD barely changes within a minute.
declare global { var __conduitRrdCache: Map<string, { at: number; data: Pt[] }> | undefined; }
const cache = (global.__conduitRrdCache ??= new Map());
const TTL = 30_000;

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get("range");
  if (!range) return NextResponse.json({ samples: getHistory() });

  const r = RANGE[range] ?? RANGE["1h"];
  const vmidParam = req.nextUrl.searchParams.get("vmid");
  const key = `${vmidParam ?? "cluster"}:${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json({ range, points: hit.data });

  try {
    let points: Pt[];
    if (vmidParam) {
      const vmid = Number(vmidParam);
      const node = await vmidNode(vmid);
      if (!node) return NextResponse.json({ range, points: [] });
      const rows = await api.lxcRrd(vmid, r.tf, node);
      points = rows.filter((p) => p.time).map((p) => ({
        t: p.time * 1000,
        cpu: Math.round((p.cpu ?? 0) * 1000) / 10,
        mem: p.maxmem ? Math.round(((p.mem ?? 0) / p.maxmem) * 1000) / 10 : 0,
        memBytes: p.mem ?? 0, maxmemBytes: p.maxmem ?? 0,
        netin: p.netin ?? 0, netout: p.netout ?? 0,
      }));
    } else {
      // cluster aggregate: per timestamp avg cpu across nodes, summed mem.
      const nodes = await api.nodes();
      const series = await Promise.all(nodes.map((n) => api.nodeRrd(r.tf, n.node).catch(() => [])));
      const byT = new Map<number, { cpu: number[]; mem: number; maxmem: number; netin: number; netout: number }>();
      for (const rows of series) for (const p of rows) {
        if (!p.time) continue;
        const e = byT.get(p.time) ?? { cpu: [], mem: 0, maxmem: 0, netin: 0, netout: 0 };
        e.cpu.push(p.cpu ?? 0); e.mem += p.mem ?? 0; e.maxmem += p.maxmem ?? 0;
        e.netin += p.netin ?? 0; e.netout += p.netout ?? 0;
        byT.set(p.time, e);
      }
      points = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, e]) => ({
        t: t * 1000,
        cpu: Math.round((e.cpu.reduce((s, c) => s + c, 0) / Math.max(1, e.cpu.length)) * 1000) / 10,
        mem: e.maxmem ? Math.round((e.mem / e.maxmem) * 1000) / 10 : 0,
        memBytes: e.mem, maxmemBytes: e.maxmem, netin: e.netin, netout: e.netout,
      }));
    }
    if (r.keep) points = points.slice(-r.keep);
    cache.set(key, { at: Date.now(), data: points });
    return NextResponse.json({ range, points });
  } catch (e) {
    return NextResponse.json({ error: String(e), range, points: [] }, { status: 200 });
  }
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
