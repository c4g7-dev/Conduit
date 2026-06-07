"use client";

import { useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { NewGroupDialog } from "@/components/new-group-dialog";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import {
  Workflow,
  Infinity as InfinityIcon,
  Pin,
  Plus,
  Minus,
  Trash2,
  Wrench,
  Network,
  Cable,
  Server,
  Database,
  Gamepad2,
  Box,
  Loader2,
  CheckCircle2,
  Users,
} from "lucide-react";

type Instance = {
  vmid: number;
  name: string;
  node: string;
  status: string;
  ip: string | null;
  ready: boolean;
};
type Task = {
  id: string;
  name: string;
  groupId: string;
  blueprintId: string;
  role: string;
  blueprintName: string;
  softwareKind: string;
  version: string;
  mode: "dynamic" | "static";
  desired: number;
  min: number;
  max: number;
  autoscale: boolean;
  playersPerInstance: number;
  cores: number;
  memory: number;
  disk: number;
  persistent: boolean;
  port: number;
  fronts: string[];
  instances: Instance[];
  live: number;
  running: number;
};
type Group = {
  id: string;
  name: string;
  slotLimit: number;
  maintenance: boolean;
  tasks: Task[];
};
type Backend = {
  taskId: string;
  taskName: string;
  role: string;
  vmid: number;
  name: string;
  ip: string | null;
  port: number;
  status: string;
};
type Routing = {
  proxy: { id: string; name: string };
  proxyInstances: { vmid: number; ip: string | null; status: string }[];
  backends: Backend[];
};
type State = { groups: Group[]; routing: Routing[]; blueprints: any[] };
type MetricRow = {
  vmid: number;
  role: string;
  reachable: boolean;
  online: number;
  max: number;
  sample: { name: string }[];
};
type Metrics = { instances: MetricRow[]; totals: { players: number; capacity: number } };

const roleIcon: Record<string, React.ElementType> = {
  proxy: Cable,
  lobby: Gamepad2,
  smp: Server,
  db: Database,
  generic: Box,
};

export default function GroupsPage() {
  const { data, loading, refresh } = usePoll<State>("/api/conduit/state", 4000);
  const { data: metrics } = usePoll<Metrics>("/api/metrics", 5000);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const mByVmid = new Map((metrics?.instances ?? []).map((r) => [r.vmid, r]));

  const set = (k: string, v: boolean) => setPending((p) => ({ ...p, [k]: v }));

  async function scale(task: Task, delta: number) {
    set(task.id, true);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delta }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`${task.name}: desired → ${json.task.desired}`);
      refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      set(task.id, false);
    }
  }

  async function delTask(task: Task) {
    if (!confirm(`Delete task "${task.name}" and destroy its ${task.live} instance(s)?`)) return;
    set(task.id, true);
    try {
      await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
      toast.success(`Task "${task.name}" removed`);
      refresh();
    } finally {
      set(task.id, false);
    }
  }

  async function toggleMaintenance(group: Group, on: boolean) {
    await fetch(`/api/groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maintenance: on }),
    });
    toast.message(`${group.name}: maintenance ${on ? "ON" : "off"}`);
    refresh();
  }

  async function delGroup(group: Group) {
    if (!confirm(`Delete group "${group.name}" and all its tasks + instances?`)) return;
    await fetch(`/api/groups/${group.id}`, { method: "DELETE" });
    toast.success(`Group "${group.name}" removed`);
    refresh();
  }

  const groups = data?.groups ?? [];
  const allTaskCandidates = groups.flatMap((g) =>
    g.tasks.filter((t) => t.role !== "proxy").map((t) => ({ id: t.id, name: t.name, role: t.role })),
  );

  return (
    <>
      <PageHeader
        title="Groups & Tasks"
        subtitle="Conduit orchestration — create groups, deploy tasks from blueprints, scale live"
        onRefresh={refresh}
        loading={loading}
      >
        <NewGroupDialog onCreated={refresh} />
      </PageHeader>

      {loading && !data && (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      )}

      {data && groups.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent">
              <Workflow className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No server groups yet</p>
              <p className="text-sm text-muted-foreground">
                Create a group, then add tasks from a blueprint to start orchestrating.
              </p>
            </div>
            <NewGroupDialog onCreated={refresh} />
          </CardContent>
        </Card>
      )}

      <div className="space-y-6">
        {groups.map((group) => (
          <Card key={group.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Workflow className="h-5 w-5 text-orange-400" />
                    {group.name}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    pool <code className="rounded bg-muted px-1 py-0.5 text-xs">{group.id}</code>
                    {" · "}slot limit {group.slotLimit}
                    {" · "}{group.tasks.length} task{group.tasks.length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5">
                    <Wrench className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">Maintenance</span>
                    <Switch
                      checked={group.maintenance}
                      onCheckedChange={(v) => toggleMaintenance(group, v)}
                    />
                  </div>
                  <NewTaskDialog
                    groupId={group.id}
                    blueprints={data?.blueprints ?? []}
                    frontCandidates={allTaskCandidates}
                    onCreated={refresh}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => delGroup(group)}
                    title="Delete group"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {group.tasks.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No tasks yet — add one from a blueprint.
                </p>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {group.tasks.map((task) => {
                    const Icon = roleIcon[task.role] ?? Box;
                    const dynamic = task.mode === "dynamic";
                    const busy = pending[task.id];
                    return (
                      <div key={task.id} className="rounded-lg border border-border/60 p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium capitalize">{task.name}</span>
                            <Badge
                              variant="outline"
                              className={
                                dynamic
                                  ? "border-orange-500/30 bg-orange-500/10 text-orange-400"
                                  : "border-sky-500/30 bg-sky-500/10 text-sky-400"
                              }
                            >
                              {dynamic ? <InfinityIcon className="mr-1 h-3 w-3" /> : <Pin className="mr-1 h-3 w-3" />}
                              {task.mode}
                            </Badge>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => delTask(task)}
                            title="Delete task"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>

                        <div className="mt-1 text-xs text-muted-foreground">
                          {task.blueprintName}
                          {task.version && (
                            <span className="text-foreground/70"> · {task.softwareKind} {task.version}</span>
                          )}
                          {" · "}{task.cores}c / {task.memory}MB / {task.disk}GB
                          {task.persistent ? " · persistent" : " · stateless"}
                        </div>

                        {/* scaler */}
                        <div className="mt-3 flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
                          <div className="text-sm">
                            <span className="font-semibold tabular-nums">{task.running}</span>
                            <span className="text-muted-foreground"> running · {task.live} live · want {task.desired}</span>
                          </div>
                          {task.autoscale ? (
                            <Badge
                              variant="outline"
                              className="border-orange-500/30 bg-orange-500/10 text-orange-400"
                              title={`auto-scales on players · ~${task.playersPerInstance}/instance · range ${task.min}–${task.max || "∞"}`}
                            >
                              <InfinityIcon className="mr-1 h-3 w-3" /> auto {task.min}–{task.max || "∞"}
                            </Badge>
                          ) : (
                            <div className="flex items-center gap-1">
                              <Button
                                size="icon"
                                variant="outline"
                                className="h-7 w-7"
                                disabled={busy || task.desired <= task.min}
                                onClick={() => scale(task, -1)}
                              >
                                <Minus className="h-3.5 w-3.5" />
                              </Button>
                              <span className="w-6 text-center text-sm font-medium tabular-nums">{task.desired}</span>
                              <Button
                                size="icon"
                                variant="outline"
                                className="h-7 w-7"
                                disabled={busy || (task.max > 0 && task.desired >= task.max)}
                                onClick={() => scale(task, +1)}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>

                        {/* instances + IPs */}
                        {task.instances.length > 0 && (
                          <div className="mt-3 space-y-1">
                            {task.instances.map((inst) => (
                              <div
                                key={inst.vmid}
                                className="flex items-center justify-between rounded border border-border/40 px-2.5 py-1.5 text-xs"
                              >
                                <span className="flex items-center gap-2">
                                  <span className="font-mono text-muted-foreground">#{inst.vmid}</span>
                                  <span>{inst.name}</span>
                                </span>
                                <span className="flex items-center gap-2">
                                  {(() => {
                                    const mr = mByVmid.get(inst.vmid);
                                    if (inst.status === "running" && mr?.reachable)
                                      return (
                                        <span className="flex items-center gap-1 text-foreground/80">
                                          <Users className="h-3 w-3" />
                                          {mr.online}/{mr.max}
                                        </span>
                                      );
                                    return null;
                                  })()}
                                  {inst.status === "running" &&
                                    (inst.ready ? (
                                      <span className="flex items-center gap-1 text-emerald-400">
                                        <CheckCircle2 className="h-3 w-3" /> ready
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1 text-amber-400">
                                        <Loader2 className="h-3 w-3 animate-spin" /> installing
                                      </span>
                                    ))}
                                  <span className="font-mono text-muted-foreground">
                                    {inst.ip ?? "…dhcp"}
                                  </span>
                                  <StatusBadge status={inst.status} />
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {task.fronts.length > 0 && (
                          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Network className="h-3.5 w-3.5" /> fronts: {task.fronts.join(", ")}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* routing tables */}
      {data && data.routing.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Network className="h-4 w-4" /> Proxy routing
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.routing.map((r) => (
              <Card key={r.proxy.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Cable className="h-4 w-4 text-orange-400" />
                    {r.proxy.name}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {r.proxyInstances.map((p) => p.ip ?? `#${p.vmid}`).join(", ") || "no proxy instance up"}
                    {" → "}{r.backends.length} backend(s)
                  </p>
                  {(() => {
                    const online = r.proxyInstances.reduce(
                      (n, p) => n + (mByVmid.get(p.vmid)?.online ?? 0),
                      0,
                    );
                    const cap = r.proxyInstances.reduce(
                      (n, p) => n + (mByVmid.get(p.vmid)?.max ?? 0),
                      0,
                    );
                    const up = r.proxyInstances.some((p) => mByVmid.get(p.vmid)?.reachable);
                    if (!up) return null;
                    return (
                      <p className="flex items-center gap-1 text-xs text-emerald-400">
                        <Users className="h-3 w-3" /> {online}/{cap} players online
                      </p>
                    );
                  })()}
                </CardHeader>
                <CardContent className="space-y-1">
                  {r.backends.length === 0 && (
                    <p className="text-xs text-muted-foreground">No backends fronted yet.</p>
                  )}
                  {r.backends.map((b) => (
                    <div
                      key={b.vmid}
                      className="flex items-center justify-between rounded border border-border/40 px-2.5 py-1.5 text-xs"
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px]">{b.role}</Badge>
                        {b.name}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {b.ip ? `${b.ip}:${b.port}` : "…dhcp"}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
