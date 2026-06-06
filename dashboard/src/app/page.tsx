"use client";

import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { bytes, pct, uptime } from "@/lib/format";
import { Boxes, Cpu, MemoryStick, Users, Server, AlertCircle } from "lucide-react";

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

export default function OverviewPage() {
  const { data, error, loading, refresh } = usePoll<Overview>("/api/overview", 5000);
  const { data: metrics } = usePoll<Metrics>("/api/metrics", 5000);
  const t = data?.totals;
  const m = metrics?.totals;
  const first = loading && !data;

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
