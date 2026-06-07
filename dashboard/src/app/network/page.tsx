"use client";

import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Users, Cable, Server } from "lucide-react";
import {
  FlowGraph,
  type ConduitState,
  type Metrics,
} from "@/components/flow-graph";

export default function NetworkPage() {
  const { data: state, error, loading, refresh } = usePoll<ConduitState>(
    "/api/conduit/state",
    3000,
  );
  const { data: metrics } = usePoll<Metrics>("/api/metrics", 3000);

  const players = metrics?.totals.players ?? 0;
  const capacity = metrics?.totals.capacity ?? 0;
  const proxies = state?.routing?.length ?? 0;
  const backends = new Set(
    (state?.routing ?? []).flatMap((r) => r.backends.map((b) => b.vmid)),
  ).size;

  return (
    <>
      <PageHeader
        title="Network"
        subtitle="Live topology — players, proxies and backend routing across the cluster"
        onRefresh={refresh}
        loading={loading}
      />

      {error && (
        <Card className="mb-6 border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-center gap-3 py-1 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            Could not reach Conduit: {error}
          </CardContent>
        </Card>
      )}

      <div className="mb-4 grid grid-cols-3 gap-4">
        <MiniStat icon={Users} label="Players" value={`${players}`} sub={`of ${capacity} slots`} accent="text-orange-400" />
        <MiniStat icon={Cable} label="Proxies" value={`${proxies}`} sub="velocity fronts" accent="text-emerald-400" />
        <MiniStat icon={Server} label="Backends" value={`${backends}`} sub="lobby / smp / db" accent="text-sky-400" />
      </div>

      <FlowGraph state={state} metrics={metrics} />
    </>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  accent: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-1">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg bg-accent ${accent}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="text-xl font-semibold leading-tight tabular-nums">{value}</div>
          <div className="text-[11px] text-muted-foreground">{sub}</div>
        </div>
      </CardContent>
    </Card>
  );
}
