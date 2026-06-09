"use client";

import { useState } from "react";
import { usePoll } from "@/hooks/use-poll";
import { Sparkline } from "@/components/sparkline";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

type Pt = { t: number; cpu: number; mem: number; memBytes: number; maxmemBytes: number; netin: number; netout: number; players?: number; containers?: number };
type Resp = { range: string; points: Pt[] };

const RANGES = ["5m", "1h", "24h", "30d"] as const;
type Range = (typeof RANGES)[number];

function fmtBytes(n: number): string {
  if (!n) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${u[i]}`;
}

/**
 * Proxmox RRD-backed metrics with a time-range selector (5m/1h/24h/30d). Cluster-wide when no
 * vmid, per-container with one. Data is the real Proxmox history (cached server-side), so it
 * renders immediately instead of building up a client-side rolling buffer.
 */
export function MetricsPanel({ vmid, className }: { vmid?: number; className?: string }) {
  const [range, setRange] = useState<Range>("1h");
  const url = `/api/metrics/history?range=${range}${vmid != null ? `&vmid=${vmid}` : ""}`;
  const { data, loading } = usePoll<Resp>(url, 15000);
  const points = data?.points ?? [];
  const last = points[points.length - 1];

  const cluster = vmid == null;
  const cards = [
    // Players: cluster = network total, per-instance = that server's count (from our sampler).
    { label: "Players", color: "#34d399", series: points.map((p) => p.players ?? 0), max: undefined as number | undefined, value: last ? `${last.players ?? 0}` : "—" },
    // Containers only makes sense cluster-wide.
    ...(cluster ? [
      { label: "Containers", color: "#f6821f", series: points.map((p) => p.containers ?? 0), max: undefined as number | undefined, value: last ? `${last.containers ?? 0}` : "—" },
    ] : []),
    { label: "CPU", color: "#7c83ff", series: points.map((p) => p.cpu), max: 100 as number | undefined, value: last ? `${last.cpu.toFixed(0)}%` : "—" },
    {
      label: "Memory", color: "#38bdf8", series: points.map((p) => p.mem), max: 100 as number | undefined,
      value: last ? (last.maxmemBytes ? `${fmtBytes(last.memBytes)} / ${fmtBytes(last.maxmemBytes)}` : `${last.mem.toFixed(0)}%`) : "—",
    },
  ];

  return (
    <div className={className}>
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow">{vmid != null ? "Container metrics" : "Cluster metrics"} · Proxmox</span>
        <div className="flex items-center gap-1">
          {loading && <Loader2 className="mr-1 h-3 w-3 animate-spin text-muted-foreground/60" />}
          {RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)}
              className={cn("rounded px-2 py-1 text-[11px] font-medium tabular-nums transition-colors",
                range === r ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:bg-accent")}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className={cn("grid gap-3 sm:grid-cols-2", cluster ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
        {cards.map((card) => (
          <div key={card.label} className="panel p-4">
            <div className="flex items-center justify-between">
              <span className="eyebrow">{card.label}</span>
              <span className="text-base font-semibold tabular-nums">{card.value}</span>
            </div>
            <div className="mt-3">
              {card.series.length < 2 ? (
                <div className="flex h-12 items-center text-xs text-muted-foreground/60">{loading ? "Loading…" : "No data for this range"}</div>
              ) : (
                <Sparkline data={card.series} color={card.color} max={card.max} height={48} label={card.label} />
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground/60">Historical CPU &amp; memory from Proxmox RRD ({range}), cached. Switch range above.</p>
    </div>
  );
}
