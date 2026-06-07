"use client";

import { useEffect, useRef } from "react";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Sparkline } from "@/components/sparkline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bytes, pct, uptime } from "@/lib/format";
import {
  Boxes, Cpu, MemoryStick, Users, Server, AlertCircle, Loader2, CheckCircle2, Network,
} from "lucide-react";

type Instance = { vmid: number; name: string; node: string; status: string; ip: string | null; ready: boolean };
type Task = { id: string; name: string; role: string; softwareKind: string; version: string; instances: Instance[] };
type Group = { id: string; name: string; tasks: Task[] };
type ConduitState = { groups: Group[] };
type MetricRow = { vmid: number; online: number; max: number; reachable: boolean };
type MetricsFull = { instances: MetricRow[] };

type Overview = {
  nodes: {
    node: string;
    status: string;
    cpu: number;
    maxcpu: number;
    mem: number;
    maxmem: number;
    uptime: number;
  }[];
  totals: {
    nodes: number;
    nodesOnline: number;
    containers: number;
    containersRunning: number;
    vms: number;
    memUsed: number;
    memMax: number;
    playersOnline: number;
  };
};

type Metrics = {
  totals: { players: number; capacity: number; backends: number; proxies: number };
};

type Sample = { t: number; players: number; cpu: number; mem: number };
type History = { samples: Sample[] };

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  loading,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-1">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent text-foreground">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          {loading ? (
            <Skeleton className="my-1 h-7 w-16" />
          ) : (
            <div className="text-2xl font-semibold tabular-nums leading-tight">
              {value}
            </div>
          )}
          {sub && !loading && <div className="text-xs text-muted-foreground">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function ChartCard({
  label,
  value,
  series,
  color,
  max,
}: {
  label: string;
  value: string;
  series: number[];
  color: string;
  max?: number;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 py-1">
        <div className="flex items-baseline justify-between">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="text-lg font-semibold tabular-nums leading-none">{value}</div>
        </div>
        {series.length < 2 ? (
          <div className="flex h-12 items-center text-xs text-muted-foreground">
            Collecting data…
          </div>
        ) : (
          <Sparkline data={series} color={color} max={max} height={48} label={label} />
        )}
      </CardContent>
    </Card>
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

  // Aggregate node CPU% / Memory% from the first node (0..1).
  const node = data?.nodes[0];
  const nodeCpu = node?.cpu ?? 0;
  const nodeMem = node && node.maxmem > 0 ? node.mem / node.maxmem : 0;
  const players = m?.players ?? 0;

  // Client-push: feed the history ring buffer whenever fresh data lands.
  const lastPush = useRef<string>("");
  useEffect(() => {
    if (!data || !metrics) return;
    const key = `${players}|${nodeCpu}|${nodeMem}`;
    if (key === lastPush.current) return;
    lastPush.current = key;
    fetch("/api/metrics/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ players, cpu: nodeCpu, mem: nodeMem }),
    }).catch(() => {});
  }, [data, metrics, players, nodeCpu, nodeMem]);

  const samples = history?.samples ?? [];
  const playerSeries = samples.map((s) => s.players);
  const cpuSeries = samples.map((s) => s.cpu * 100);
  const memSeries = samples.map((s) => s.mem * 100);

  const playerOf = new Map((metrics?.instances ?? []).map((r) => [r.vmid, r]));
  const services = (state?.groups ?? []).flatMap((g) =>
    g.tasks.flatMap((task) =>
      task.instances.map((i) => ({
        ...i,
        group: g.name,
        task: task.name,
        role: task.role,
        software: `${task.softwareKind} ${task.version}`,
        port: 25565,
        m: playerOf.get(i.vmid),
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
        <Card className="mb-6 border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-center gap-3 py-1 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            Could not reach Proxmox: {error}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={Boxes}
          label="Containers"
          value={`${t?.containersRunning ?? 0}/${t?.containers ?? 0}`}
          sub="running / total"
          loading={first}
        />
        <Stat
          icon={Server}
          label="Nodes"
          value={`${t?.nodesOnline ?? 0}/${t?.nodes ?? 0}`}
          sub="online"
          loading={first}
        />
        <Stat
          icon={MemoryStick}
          label="Memory"
          value={t ? `${pct(t.memUsed, t.memMax)}%` : "—"}
          sub={t ? `${bytes(t.memUsed)} / ${bytes(t.memMax)}` : undefined}
          loading={first}
        />
        <Stat
          icon={Users}
          label="Players"
          value={m ? `${m.players}` : "0"}
          sub={m ? `of ${m.capacity} slots · live via SLP` : "live via SLP"}
          loading={first}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <ChartCard
          label="Players over time"
          value={`${players}`}
          series={playerSeries}
          color="var(--color-emerald-400, #34d399)"
        />
        <ChartCard
          label="Node CPU"
          value={`${Math.round(nodeCpu * 100)}%`}
          series={cpuSeries}
          color="var(--color-orange-400, #fb923c)"
          max={100}
        />
        <ChartCard
          label="Node Memory"
          value={`${Math.round(nodeMem * 100)}%`}
          series={memSeries}
          color="var(--color-sky-400, #38bdf8)"
          max={100}
        />
      </div>

      <h2 className="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Network className="h-4 w-4" /> Services
        {services.length > 0 && (
          <Badge variant="secondary" className="text-[10px]">{services.length}</Badge>
        )}
      </h2>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Software</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>Node</TableHead>
                <TableHead>Address</TableHead>
                <TableHead className="text-right">Players</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((s) => {
                const running = s.status === "running";
                return (
                  <TableRow key={s.vmid}>
                    <TableCell className="font-medium">
                      {s.name}
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">#{s.vmid}</span>
                    </TableCell>
                    <TableCell>
                      {running && !s.ready ? (
                        <span className="flex items-center gap-1 text-xs text-amber-400">
                          <Loader2 className="h-3 w-3 animate-spin" /> installing
                        </span>
                      ) : running && s.ready ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" /> ready
                        </span>
                      ) : (
                        <StatusBadge status={s.status} />
                      )}
                    </TableCell>
                    <TableCell><Badge variant="secondary" className="text-[10px]">{s.role}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.software}</TableCell>
                    <TableCell className="text-sm">{s.group}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.node}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {s.ip ? `${s.ip}:${s.port}` : "…dhcp"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {s.m?.reachable ? `${s.m.online}/${s.m.max}` : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!state &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    <TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))}
              {state && services.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No services running. Create a group and a task to deploy one.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Nodes
      </h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.nodes.map((n) => (
          <Card key={n.node}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="h-4 w-4 text-muted-foreground" />
                {n.node}
              </CardTitle>
              <StatusBadge status={n.status} />
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Cpu className="h-3.5 w-3.5" /> CPU
                  </span>
                  <span className="tabular-nums">
                    {Math.round((n.cpu ?? 0) * 100)}%{" "}
                    <span className="text-muted-foreground">of {n.maxcpu} cores</span>
                  </span>
                </div>
                <Progress value={Math.round((n.cpu ?? 0) * 100)} />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <MemoryStick className="h-3.5 w-3.5" /> Memory
                  </span>
                  <span className="tabular-nums">
                    {bytes(n.mem)}{" "}
                    <span className="text-muted-foreground">/ {bytes(n.maxmem)}</span>
                  </span>
                </div>
                <Progress value={pct(n.mem, n.maxmem)} />
              </div>
              <div className="text-xs text-muted-foreground">
                Uptime {uptime(n.uptime)}
              </div>
            </CardContent>
          </Card>
        ))}
        {loading && !data &&
          Array.from({ length: 2 }).map((_, i) => (
            <Card key={`sk-${i}`}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </CardHeader>
              <CardContent className="space-y-4">
                <Skeleton className="h-2 w-full" />
                <Skeleton className="h-2 w-full" />
                <Skeleton className="h-3 w-20" />
              </CardContent>
            </Card>
          ))}
      </div>
    </>
  );
}
