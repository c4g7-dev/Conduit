"use client";

import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { AlertTriangle, AlertCircle, Activity as ActivityIcon, Info } from "lucide-react";

type Ev = { id: number; at: number; level: "info" | "warn" | "error"; msg: string };
type Alert = { level: "warn" | "error"; msg: string; vmid?: number };
type Data = { events: Ev[]; alerts: Alert[] };

const LEVEL = {
  info: { color: "#7c83ff", Icon: Info },
  warn: { color: "#fbbf24", Icon: AlertTriangle },
  error: { color: "#f87171", Icon: AlertCircle },
};

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ActivityPage() {
  const { data, loading, refresh } = usePoll<Data>("/api/activity", 4000);
  const events = data?.events ?? [];
  const alerts = data?.alerts ?? [];

  return (
    <>
      <PageHeader title="Activity" subtitle="Engine events and live health across the cluster" onRefresh={refresh} loading={loading} />

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="mb-4 space-y-2">
          {alerts.map((a, i) => {
            const L = LEVEL[a.level];
            return (
              <div key={i} className="flex items-center gap-2.5 rounded-md border px-3 py-2 text-[13px]"
                style={{ borderColor: `color-mix(in oklch, ${L.color} 30%, transparent)`, background: `color-mix(in oklch, ${L.color} 8%, transparent)`, color: L.color }}>
                <L.Icon className="h-4 w-4 shrink-0" />
                <span>{a.msg}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Event timeline */}
      <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
          <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="eyebrow">Event log</span>
          <span className="ml-auto text-[11px] text-muted-foreground/60">{events.length} events</span>
        </div>
        <div className="max-h-[calc(100vh-16rem)] overflow-y-auto">
          {events.map((e) => {
            const L = LEVEL[e.level];
            return (
              <div key={e.id} className="flex items-start gap-3 border-b border-hairline px-4 py-2 last:border-0">
                <L.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: L.color }} />
                <span className="flex-1 font-mono text-[12px] leading-relaxed text-foreground/90">{e.msg}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">{ago(e.at)}</span>
              </div>
            );
          })}
          {events.length === 0 && (
            <div className={cn("px-4 py-16 text-center text-sm text-muted-foreground")}>
              No engine events yet — actions like scaling, provisioning and routing changes appear here.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
