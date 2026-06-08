"use client";

import { useEffect, useRef } from "react";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Sparkline } from "@/components/sparkline";
import { StatusBadge } from "@/components/status-badge";
import { RoleDot } from "@/components/role-dot";
import { bytes, pct, uptime } from "@/lib/format";
import {
  Boxes, Cpu, MemoryStick, Users, Server, AlertCircle, Loader2, CheckCircle2,
} from "lucide-react";

type Instance = { vmid: number; name: string; node: string; status: string; ip: string | null; ready: boolean };
type Task = { id: string; name: string; role: string; softwareKind: string; version: string; instances: Instance[] };
type Group = { id: string; name: string; tasks: Task[] };
type ConduitState = { groups: Group[] };
type MetricRow = { vmid: number; online: number; max: number; reachable: boolean };
type MetricsFull = { instances: MetricRow[] };

type Overview = {
  nodes: { node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; uptime: number }[];
  totals: {
    nodes: number; nodesOnline: number; containers: number; containersRunning: number;
    vms: number; memUsed: number; memMax: number; playersOnline: number;
  };
};
type Metrics = { totals: { players: number; capacity: number; backends: number; proxies: number } };
type Sample = { t: number; players: number; cpu: number; mem: number };
type History = { samples: Sample[] };

function StatTile({ icon: Icon, label, value, sub, loading }: {
  icon: React.ElementType; label: string; value: string; sub?: string; loading?: boolean;
}) {
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="eyebrow">{label}</span>
      </div>
      {loading ? (
        <div className="mt-2 h-7 w-20 animate-pulse rounded bg-accent" />
      ) : (
        <div className="mt-1.5 text-2xl font-semibold tabular-nums leading-none tracking-tight">{value}</div>
      )}
      {sub && !loading && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ChartCard({ label, value, series, color, max }: {
  label: string; value: string; series: number[]; color: string; max?: number;
}) {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <div className="text-base font-semibold tabular-nums">{value}</div>
      </div>
      <div className="mt-3">
        {series.length < 2 ? (
          <div className="flex h-12 items-center text-xs text-muted-foreground/60">Collecting data…</div>
        ) : (
          <Sparkline data={series} color={color} max={max} height={48} label={label} />
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="mb-3 mt-7 flex items-center gap-2">
      <h2 className="eyebrow">{children}</h2>
      {count != null && (
        <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{count}</span>
      )}
    </div>
  );
}

export default function OverviewPage() {
  const { data, error, loading, refresh } = usePoll<Overview>("/api/overview", 5000);
  const { data: metrics } = usePoll<Metrics & MetricsFull>("/api/metrics", 5000);
  const { data: state } = usePoll<ConduitState>("/api/conduit/state", 5000);
  const { data: history } = usePoll<History>("/api/metrics/history", 5000);
  const t = data?.totals;
  const m = metrics?.totals;
  const first = loading && !data;

  // Cluster-wide CPU + memory so the KPI tiles and the sparklines agree (the old
  // sparklines tracked only node[0], which made "Memory" disagree with the KPI).
  const nodes = data?.nodes ?? [];
  const clusterCpu = nodes.length ? nodes.reduce((a, n) => a + (n.cpu ?? 0), 0) / nodes.length : 0;
  const clusterMem = t && t.memMax > 0 ? t.memUsed / t.memMax : 0;
  const players = m?.players ?? 0;

  const lastPush = useRef<string>("");
  useEffect(() => {
    if (!data || !metrics) return;
    const key = `${players}|${clusterCpu.toFixed(3)}|${clusterMem.toFixed(3)}`;
    if (key === lastPush.current) return;
    lastPush.current = key;
    fetch("/api/metrics/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ players, cpu: clusterCpu, mem: clusterMem }),
    }).catch(() => {});
  }, [data, metrics, players, clusterCpu, clusterMem]);

  const samples = history?.samples ?? [];
  const playerSeries = samples.map((s) => s.players);
  const cpuSeries = samples.map((s) => s.cpu * 100);
  const memSeries = samples.map((s) => s.mem * 100);

  const playerOf = new Map((metrics?.instances ?? []).map((r) => [r.vmid, r]));
  const services = (state?.groups ?? []).flatMap((g) =>
    g.tasks.flatMap((task) =>
      task.instances.map((i) => ({
        ...i, group: g.name, task: task.name, role: task.role,
        software: `${task.softwareKind} ${task.version}`, port: 25565, m: playerOf.get(i.vmid),
      })),
    ),
  );

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Live state of the Conduit-managed Proxmox cluster"
        onRefresh={refresh}
        loading={loading}
      />

      {error && (
        <div className="mb-5 flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Could not reach Proxmox: {error}
        </div>
      )}

      {/* KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={Boxes} label="Containers" value={`${t?.containersRunning ?? 0}/${t?.containers ?? 0}`} sub="running / total" loading={first} />
        <StatTile icon={Server} label="Nodes" value={`${t?.nodesOnline ?? 0}/${t?.nodes ?? 0}`} sub="online" loading={first} />
        <StatTile icon={MemoryStick} label="Memory" value={t ? `${pct(t.memUsed, t.memMax)}%` : "—"} sub={t ? `${bytes(t.memUsed)} / ${bytes(t.memMax)}` : undefined} loading={first} />
        <StatTile icon={Users} label="Players" value={m ? `${m.players}` : "0"} sub={m ? `of ${m.capacity} slots` : undefined} loading={first} />
      </div>

      {/* Sparklines — all cluster-wide */}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <ChartCard label="Players" value={`${players}`} series={playerSeries} color="#34d399" />
        <ChartCard label="Cluster CPU" value={`${Math.round(clusterCpu * 100)}%`} series={cpuSeries} color="#f6821f" max={100} />
        <ChartCard label="Cluster Memory" value={`${Math.round(clusterMem * 100)}%`} series={memSeries} color="#38bdf8" max={100} />
      </div>

      <SectionLabel count={services.length}>Services</SectionLabel>

      <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline">
              {["Service", "Status", "Role", "Software", "Group", "Node", "Address", "Players"].map((h, i) => (
                <th key={h} className={`px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground ${i === 7 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {services.map((s) => {
              const running = s.status === "running";
              return (
                <tr
                  key={s.vmid}
                  className="cursor-pointer border-b border-hairline transition-colors last:border-0 hover:bg-accent/40"
                  onClick={() => (window.location.href = `/services/${s.vmid}`)}
                >
                  <td className="px-4 py-2.5 font-medium">
                    <span className="flex items-center gap-2.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running && s.ready ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                      {s.name}
                      <span className="font-mono text-[10px] text-muted-foreground/50">#{s.vmid}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {running && !s.ready ? (
                      <span className="flex items-center gap-1 text-xs text-amber-400"><Loader2 className="h-3 w-3 animate-spin" /> installing</span>
                    ) : running && s.ready ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3 w-3" /> ready</span>
                    ) : (
                      <StatusBadge status={s.status} />
                    )}
                  </td>
                  <td className="px-4 py-2.5"><RoleDot role={s.role} label /></td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{s.software}</td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">{s.group}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{s.node}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{s.ip ? `${s.ip}:${s.port}` : "…dhcp"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-sm">
                    {s.m?.reachable ? <span className="font-medium text-emerald-400">{s.m.online}/{s.m.max}</span> : <span className="text-muted-foreground/40">—</span>}
                  </td>
                </tr>
              );
            })}
            {!state && Array.from({ length: 3 }).map((_, i) => (
              <tr key={`sk-${i}`} className="border-b border-hairline"><td colSpan={8} className="px-4 py-3"><div className="h-4 w-full animate-pulse rounded bg-accent" /></td></tr>
            ))}
            {state && services.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">No services running — create a group and server to deploy one.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <SectionLabel>Nodes</SectionLabel>

      <div className="grid gap-3 lg:grid-cols-3">
        {nodes.map((n) => (
          <div key={n.node} className="panel p-4">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent">
                  <Server className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <div className="font-semibold">{n.node}</div>
                  <div className="text-xs text-muted-foreground">up {uptime(n.uptime)}</div>
                </div>
              </div>
              <StatusBadge status={n.status} />
            </div>
            <div className="space-y-3">
              <ResourceBar icon={Cpu} label="CPU" value={`${Math.round((n.cpu ?? 0) * 100)}%`} hint={`${n.maxcpu} cores`} ratio={n.cpu ?? 0} color="#f6821f" />
              <ResourceBar icon={MemoryStick} label="Memory" value={bytes(n.mem)} hint={bytes(n.maxmem)} ratio={n.maxmem ? n.mem / n.maxmem : 0} color="#38bdf8" />
            </div>
          </div>
        ))}
        {loading && !data && Array.from({ length: 3 }).map((_, i) => (
          <div key={`sk-${i}`} className="panel p-4">
            <div className="mb-4 h-8 w-28 animate-pulse rounded bg-accent" />
            <div className="mb-3 h-1.5 w-full animate-pulse rounded-full bg-accent" />
            <div className="h-1.5 w-full animate-pulse rounded-full bg-accent" />
          </div>
        ))}
      </div>
    </>
  );
}

function ResourceBar({ icon: Icon, label, value, hint, ratio, color }: {
  icon: React.ElementType; label: string; value: string; hint: string; ratio: number; color: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-muted-foreground"><Icon className="h-3 w-3" /> {label}</span>
        <span className="font-mono font-medium">{value}<span className="text-muted-foreground"> / {hint}</span></span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-accent">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(ratio * 100)}%`, background: color }} />
      </div>
    </div>
  );
}
