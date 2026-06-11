"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { useStream } from "@/hooks/use-stream";
import { PageHeader } from "@/components/page-header";
import { NewGroupDialog } from "@/components/new-group-dialog";
import { NewSubgroupDialog } from "@/components/new-subgroup-dialog";
import { DeployServerDialog } from "@/components/deploy-server-dialog";
import { SubgroupSettingsDialog } from "@/components/subgroup-settings-dialog";
import { VersionCard, type TaskVersionStatus } from "@/components/version-card";
import { EditGroupDialog } from "@/components/edit-group-dialog";
import { EditTaskDialog } from "@/components/edit-task-dialog";
import { MotdDialog } from "@/components/motd-dialog";
import { StatusBadge } from "@/components/status-badge";
import { RoleDot, roleColor } from "@/components/role-dot";
import { FlowGraph } from "@/components/flow-graph";
import { ShardingPanel } from "@/components/sharding-panel";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  Search,
  Plus,
  Minus,
  Trash2,
  Wrench,
  Settings2,
  Layers,
  ArrowRightLeft,
  Infinity as InfinityIcon,
  Terminal,
  FolderOpen,
  Play,
  Square,
  RotateCw,
  Power,
  Users,
  CheckCircle2,
  Loader2,
  ServerCog,
  Network,
  ArrowRight,
  CornerDownRight,
  CornerUpLeft,
  FolderPlus,
  Rocket,
  Hourglass,
  Star,
  X,
  ArrowUpCircle,
  RefreshCw,
  FolderSync,
  ListOrdered,
} from "lucide-react";

/* ---- types (mirror /api/conduit/state) ----------------------------------- */
type Instance = { vmid: number; name: string; node: string; status: string; ip: string | null; ready: boolean };
type Task = {
  id: string; name: string; groupId: string; blueprintId: string; role: string;
  blueprintName: string; softwareKind: string; version: string; motd: string;
  mode: "dynamic" | "static"; desired: number; min: number; max: number;
  autoscale: boolean; playersPerInstance: number; cores: number; memory: number;
  disk: number; persistent: boolean; port: number; fronts: string[]; tryOrder?: string[];
  subgroupId?: string; maintenance?: boolean; templateSync?: boolean; templateSyncRestart?: boolean;
  instances: Instance[]; live: number; running: number;
};
type Subgroup = { id: string; name: string; maintenance: boolean; parentId?: string; slotLimit?: number; fullMessage?: string };
type Group = { id: string; name: string; slotLimit: number; maintenance: boolean; subgroups?: Subgroup[]; tasks: Task[] };
type Backend = { taskId: string; taskName: string; role: string; vmid: number; name: string; ip: string | null; port: number; status: string };
type Routing = { proxy: { id: string; name: string }; proxyInstances: { vmid: number; ip: string | null; status: string }[]; backends: Backend[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type State = { groups: Group[]; routing: Routing[]; blueprints: any[] };
type MetricRow = { vmid: number; role: string; reachable: boolean; online: number; max: number; sample: { name: string }[] };
type Metrics = { instances: MetricRow[]; totals: { players: number; capacity: number } };

type Tab = "overview" | "instances" | "routing" | "world" | "settings";

type ConnLive = {
  active: boolean;
  servers: { id: string; env: string; lastSeen: number; queues?: { id: string; players: { uuid: string; name: string; priority?: boolean }[] }[] }[];
};
// software kinds that report via a connector — only these are judged "live" by its freshness
const CONNECTED_KINDS = new Set(["paper", "velocity", "hytale"]);

export default function ServersPage() {
  const { data, loading, refresh } = usePoll<State>("/api/conduit/state", 4000);
  const { data: metrics } = usePoll<Metrics>("/api/metrics", 5000);
  // live connector state over SSE (instant restart/queue visibility), polling fallback
  const { data: connData } = useStream<ConnLive>("/api/stream", "/api/connector/servers", 5000);
  // software version status (hotfix/update-available) — slow-moving, poll lazily
  const { data: verData, refresh: refreshVers } = usePoll<{ tasks: TaskVersionStatus[] }>("/api/versions/status", 60000);
  const verByTask = useMemo(() => new Map((verData?.tasks ?? []).map((v) => [v.taskId, v])), [verData]);
  const queuesById = useMemo(() => {
    const m = new Map<string, { uuid: string; name: string; priority?: boolean }[]>();
    for (const s of connData?.servers ?? []) {
      if (s.env !== "proxy") continue;
      for (const q of s.queues ?? []) m.set(q.id, q.players);
    }
    return m;
  }, [connData]);
  // vmids with a FRESH connector heartbeat — a restarting instance drops out within seconds,
  // so the status flips to "restarting…" instead of showing a stale green "ready".
  // Freshness is judged relative to the NEWEST heartbeat in the snapshot (the proxy beats
  // every ~1s), which keeps the memo pure and immune to panel↔browser clock skew.
  const connFresh = useMemo(() => {
    const s = new Set<number>();
    const servers = connData?.servers ?? [];
    const newest = servers.reduce((n, sv) => Math.max(n, sv.lastSeen), 0);
    for (const sv of servers) {
      if (newest - sv.lastSeen > 12_000) continue;
      const m = /-(\d+)$/.exec(sv.id);
      if (m) s.add(Number(m[1]));
    }
    return s;
  }, [connData]);

  const groups = useMemo(() => data?.groups ?? [], [data]);
  const allTasks = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const mByVmid = useMemo(
    () => new Map((metrics?.instances ?? []).map((r) => [r.vmid, r])),
    [metrics],
  );
  const taskNameById = useMemo(
    () => new Map(allTasks.map((t) => [t.id, t.name])),
    [allTasks],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [sgFor, setSgFor] = useState<{ group: Group; parent?: Subgroup } | null>(null);
  const [sgSettings, setSgSettings] = useState<{ group: Group; sg: Subgroup } | null>(null);
  const [deployTo, setDeployTo] = useState<{ group: Group; sg?: Subgroup } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // "g:<id>" | "sg:<gid>:<sgid>"
  const [queueView, setQueueView] = useState<{ sg: Subgroup } | null>(null);

  async function unqueue(name: string) {
    const res = await fetch("/api/connector/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "unqueue", player: name }),
    });
    const json = await res.json();
    if (json.error) return toast.error(json.error);
    toast.success(`${name} removed from the queue`);
    // the SSE stream pushes the shrunken queue as soon as the proxy drains (~1s)
  }
  const { data: nodesData } = usePoll<{ nodes: { node: string; status: string }[] }>("/api/nodes", 15000);
  const nodeNames = (nodesData?.nodes ?? []).filter((n) => n.status === "online").map((n) => n.node);
  const [tab, setTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});

  // Default selection → first server once data loads.
  useEffect(() => {
    if (!selectedId && allTasks.length) setSelectedId(allTasks[0].id);
  }, [allTasks, selectedId]);

  const selected = allTasks.find((t) => t.id === selectedId) ?? null;
  const selectedGroup = groups.find((g) => g.id === selected?.groupId) ?? null;
  // Routing tab only applies to proxies.
  useEffect(() => {
    if (tab === "routing" && selected?.role !== "proxy") setTab("overview");
    if (tab === "world" && selected?.softwareKind !== "paper") setTab("overview");
  }, [selected, tab]);

  const set = (k: string, v: boolean) => setPending((p) => ({ ...p, [k]: v }));

  async function scale(task: Task, delta: number) {
    set(task.id, true);
    try {
      // Manual scale-up on a static task should raise its cap too, so `desired` isn't
      // clamped back down by the engine (a static min=1/max=1 task could never grow otherwise).
      const body: Record<string, number> = { delta };
      if (!task.autoscale && delta > 0 && task.max > 0 && task.desired + delta > task.max) {
        body.max = task.desired + delta;
      }
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
    if (!confirm(`Delete server "${task.name}" and destroy its ${task.live} instance(s)?`)) return;
    set(task.id, true);
    try {
      await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
      toast.success(`Server "${task.name}" removed`);
      if (selectedId === task.id) setSelectedId(null);
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

  async function toggleSgMaintenance(group: Group, sg: Subgroup, on: boolean) {
    await fetch(`/api/groups/${group.id}/subgroups/${sg.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maintenance: on }),
    });
    toast.message(`${sg.name}: maintenance ${on ? "ON" : "off"}`);
    refresh();
  }

  async function delSubgroup(group: Group, sg: Subgroup) {
    if (!confirm(`Delete subgroup "${sg.name}"? Its servers stay and rejoin ${group.name} directly.`)) return;
    await fetch(`/api/groups/${group.id}/subgroups/${sg.id}`, { method: "DELETE" });
    toast.success(`Subgroup "${sg.name}" removed`);
    refresh();
  }

  async function toggleTaskMaintenance(task: Task, on: boolean) {
    await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maintenance: on }),
    });
    toast.message(`${task.name}: maintenance ${on ? "ON" : "off"}`);
    refresh();
  }

  async function setTaskSubgroup(task: Task, sgId: string | null) {
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subgroupId: sgId }),
    });
    const json = await res.json();
    if (json.error) return toast.error(json.error);
    toast.success(sgId ? `${task.name} → subgroup ${sgId}` : `${task.name} removed from subgroup`);
    refresh();
  }

  async function resyncFiles(task: Task) {
    if (!confirm(`Re-apply the template files (global/${task.softwareKind} + egg + task overlays) to ${task.name}'s ${task.running} running instance(s) and restart them?`)) return;
    set(task.id, true);
    try {
      const res = await fetch(`/api/tasks/${task.id}/resync`, { method: "POST" });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`${task.name}: files re-applied to ${json.results.filter((r: { ok: boolean }) => r.ok).length} instance(s)`);
      refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      set(task.id, false);
    }
  }

  async function patchTask(task: Task, body: Record<string, unknown>, msg: string) {
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) return toast.error(json.error);
    toast.success(msg);
    refresh();
  }
  const toggleTemplateSync = (task: Task) =>
    patchTask(task, { templateSync: !task.templateSync },
      `${task.name}: auto file-sync ${!task.templateSync ? "ON — overlay edits re-apply automatically" : "off"}`);
  const toggleTemplateSyncRestart = (task: Task) =>
    patchTask(task, { templateSyncRestart: !task.templateSyncRestart },
      `${task.name}: auto-sync restart ${!task.templateSyncRestart ? "ON — instances restart on change" : "off — changes load on next restart"}`);

  /** Drag & drop: move a task into a group (loose) or a subgroup — cross-group moves
   *  re-home the task; the destination's settings (maintenance, caps, routing scope)
   *  apply via the next proxy-config build. */
  async function dropTask(taskId: string, destGroupId: string, destSgId: string | null) {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.groupId === destGroupId && (task.subgroupId ?? null) === destSgId) return;
    const body: Record<string, unknown> = { subgroupId: destSgId };
    if (task.groupId !== destGroupId) body.groupId = destGroupId;
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) return toast.error(json.error);
    const dest = destSgId ? `${destGroupId} / ${destSgId}` : destGroupId;
    toast.success(`${task.name} → ${dest}`);
    refresh();
  }

  const dragProps = (key: string, gId: string, sgId: string | null) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(key); },
    onDragLeave: () => setDropTarget((d) => (d === key ? null : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const id = e.dataTransfer.getData("text/conduit-task");
      if (id) dropTask(id, gId, sgId);
    },
  });

  async function delGroup(group: Group) {
    if (!confirm(`Delete group "${group.name}" and all its servers + instances?`)) return;
    await fetch(`/api/groups/${group.id}`, { method: "DELETE" });
    toast.success(`Group "${group.name}" removed`);
    refresh();
  }

  async function migrate(inst: Instance, target: string) {
    set(`i${inst.vmid}`, true);
    try {
      const res = await fetch(`/api/containers/${inst.vmid}/migrate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, node: inst.node }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`#${inst.vmid}: migrating → ${target}`);
      setTimeout(refresh, 2000);
    } catch (e) { toast.error(String(e)); } finally { set(`i${inst.vmid}`, false); }
  }

  async function instAction(inst: Instance, action: "start" | "shutdown" | "stop" | "reboot") {
    set(`i${inst.vmid}`, true);
    try {
      const res = await fetch(`/api/containers/${inst.vmid}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, node: inst.node }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`#${inst.vmid}: ${action}`);
      setTimeout(refresh, 1200);
    } catch (e) {
      toast.error(String(e));
    } finally {
      set(`i${inst.vmid}`, false);
    }
  }

  async function deleteInstance(inst: Instance) {
    set(`i${inst.vmid}`, true);
    try {
      const res = await fetch(`/api/containers/${inst.vmid}`, { method: "DELETE" });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`#${inst.vmid} deleted`);
      setTimeout(refresh, 1200);
    } catch (e) {
      toast.error(String(e));
    } finally {
      set(`i${inst.vmid}`, false);
    }
  }

  async function setFronts(proxy: Task, fronts: string[]) {
    set(proxy.id, true);
    try {
      const res = await fetch(`/api/tasks/${proxy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fronts }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success("Routing updated — proxy reloaded");
      refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      set(proxy.id, false);
    }
  }

  async function setTryOrder(proxy: Task, tryOrder: string[] | null) {
    set(proxy.id, true);
    try {
      const res = await fetch(`/api/tasks/${proxy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tryOrder }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(tryOrder ? "Try order updated — applies on the next heartbeat" : "Try order reset to default");
      refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      set(proxy.id, false);
    }
  }

  const frontCandidates = allTasks
    .filter((t) => t.role !== "proxy")
    .map((t) => ({ id: t.id, name: t.name, role: t.role }));

  const q = search.trim().toLowerCase();

  return (
    <>
      <PageHeader
        title="Servers"
        subtitle="Orchestrate proxies, server fleets and routing across the cluster"
        onRefresh={refresh}
        loading={loading}
      >
        <NewGroupDialog onCreated={refresh} />
      </PageHeader>

      {data && groups.length === 0 ? (
        <EmptyState onCreated={refresh} />
      ) : (
        <div className="flex flex-col gap-4 md:min-h-[calc(100vh-9rem)] md:flex-row">
          {/* ---- Left rail: groups → servers tree (full-width + capped height on mobile, fixed column on desktop) ---- */}
          <div className="flex max-h-[45vh] w-full shrink-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel md:max-h-none md:w-72">
            <div className="flex items-center gap-2 border-b border-hairline px-2.5 py-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search servers…"
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {(loading && !data) && (
                <div className="space-y-1 p-1">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-7 animate-pulse rounded bg-accent/50" />
                  ))}
                </div>
              )}
              {groups.map((group) => {
                const isCol = collapsed[group.id];
                const servers = group.tasks.filter(
                  (t) => !q || t.name.toLowerCase().includes(q) || t.role.includes(q),
                );
                if (q && servers.length === 0) return null;
                const sgs = group.subgroups ?? [];
                const loose = servers.filter((t) => !t.subgroupId || !sgs.some((s) => s.id === t.subgroupId));
                /** maintenance anywhere up a subgroup's parent chain */
                const chainMaint = (sgId: string | undefined): boolean => {
                  let cur = sgs.find((s) => s.id === sgId);
                  for (let i = 0; cur && i < 50; i++) {
                    if (cur.maintenance) return true;
                    cur = sgs.find((s) => s.id === cur!.parentId);
                  }
                  return false;
                };

                // Shared row renderer so loose + subgrouped tasks stay identical.
                const taskRow = (task: Task, sgMaint: boolean) => {
                  const active = task.id === selectedId;
                  const healthy = task.running > 0 && task.running >= task.desired;
                  const inMaint = !!task.maintenance || sgMaint || group.maintenance;
                  return (
                    <ContextMenu key={task.id}>
                      <ContextMenuTrigger
                        render={
                          <button
                            onClick={() => setSelectedId(task.id)}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/conduit-task", task.id);
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            className={cn(
                              "group flex w-full cursor-grab items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors active:cursor-grabbing",
                              active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            )}
                            title="Drag onto a group or subgroup to move it"
                          />
                        }
                      >
                        <RoleDot role={task.role} />
                        <span className="flex-1 truncate">{task.name}</span>
                        {(() => {
                          const v = verByTask.get(task.id);
                          if (!v || (!v.hotfixAvailable && !v.updateAvailable)) return null;
                          // hotfix (same line) = amber; a new full version = yellow nudge, unless
                          // the version is pinned → muted grey (deliberately locked, not an alert).
                          return (
                            <ArrowUpCircle
                              className={cn(
                                "h-3 w-3 shrink-0",
                                v.hotfixAvailable ? "text-amber-500" : v.pinned ? "text-muted-foreground/50" : "text-yellow-400",
                              )}
                              aria-label={v.hotfixAvailable ? `hotfix available: build ${v.latestBuild}` : `newer version available: ${v.latestVersion}`}
                            />
                          );
                        })()}
                        {inMaint && <Wrench className="h-3 w-3 shrink-0 text-amber-400" />}
                        {!task.persistent && (
                          <span title="Ephemeral — instances are created from the template and discarded on scale-down (no persistent data)."
                            className="flex items-center gap-0.5 rounded bg-brand/10 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-brand/80">
                            <Layers className="h-2.5 w-2.5" /> temp
                          </span>
                        )}
                        <span
                          className={cn(
                            "tabular-nums text-[11px]",
                            healthy ? "text-emerald-400/80" : task.running > 0 ? "text-amber-400/80" : "text-muted-foreground/50",
                          )}
                        >
                          {task.running}/{task.desired}
                        </span>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuLabel>{task.name}</ContextMenuLabel>
                        <ContextMenuItem onClick={() => setEditTask(task)}>
                          <Settings2 /> Settings
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => { setSelectedId(task.id); setTab("instances"); }}>
                          <ServerCog /> View instances
                        </ContextMenuItem>
                        {!task.autoscale && (
                          <>
                            <ContextMenuItem onClick={() => scale(task, +1)}><Plus /> Scale up</ContextMenuItem>
                            <ContextMenuItem disabled={task.desired <= task.min} onClick={() => scale(task, -1)}><Minus /> Scale down</ContextMenuItem>
                          </>
                        )}
                        <ContextMenuItem onClick={() => toggleTaskMaintenance(task, !task.maintenance)}>
                          <Wrench /> {task.maintenance ? "Disable maintenance" : "Enable maintenance"}
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => resyncFiles(task)}>
                          <RefreshCw /> Re-sync files from template
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => toggleTemplateSync(task)}>
                          <FolderSync /> {task.templateSync ? "Disable auto file-sync" : "Enable auto file-sync"}
                        </ContextMenuItem>
                        {task.templateSync && (
                          <ContextMenuItem onClick={() => toggleTemplateSyncRestart(task)}>
                            <RotateCw /> {task.templateSyncRestart ? "Auto-sync: stop restarting" : "Auto-sync: restart on change"}
                          </ContextMenuItem>
                        )}
                        {(sgs.length > 0 || task.subgroupId) && <ContextMenuSeparator />}
                        {sgs.filter((s) => s.id !== task.subgroupId).map((s) => (
                          <ContextMenuItem key={s.id} onClick={() => setTaskSubgroup(task, s.id)}>
                            <CornerDownRight /> Move to {s.name}
                          </ContextMenuItem>
                        ))}
                        {task.subgroupId && (
                          <ContextMenuItem onClick={() => setTaskSubgroup(task, null)}>
                            <CornerUpLeft /> Remove from subgroup
                          </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onClick={() => delTask(task)}>
                          <Trash2 /> Delete server
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                };

                /** Recursive subgroup section: header (drop target + context menu) + its tasks
                 *  + nested child subgroups, indented per depth. */
                const renderSg = (sg: Subgroup, depth: number): React.ReactNode => {
                  const sgTasks = servers.filter((t) => t.subgroupId === sg.id);
                  const children = sgs.filter((s) => s.parentId === sg.id);
                  if (q && sgTasks.length === 0 && children.length === 0) return null;
                  const online = sgTasks.reduce((n, t) => n + t.instances.reduce((m, i) => m + (mByVmid.get(i.vmid)?.online ?? 0), 0), 0);
                  const running = sgTasks.reduce((n, t) => n + t.running, 0);
                  const dKey = `sg:${group.id}:${sg.id}`;
                  const maint = chainMaint(sg.id);
                  const sgCol = collapsed[dKey];
                  const queued = queuesById.get(sg.id) ?? [];
                  return (
                    <div key={sg.id} className="pt-0.5">
                      <ContextMenu>
                        <ContextMenuTrigger
                          render={
                            <div
                              className={cn(
                                "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 transition-colors hover:bg-accent/40",
                                dropTarget === dKey && "bg-brand/15 ring-1 ring-brand/50",
                              )}
                              onClick={() => setCollapsed((c) => ({ ...c, [dKey]: !c[dKey] }))}
                              {...dragProps(dKey, group.id, sg.id)}
                            />
                          }
                        >
                          <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform", sgCol && "-rotate-90")} />
                          <span className={cn(
                            "flex-1 truncate text-[10px] font-semibold uppercase tracking-wider",
                            maint ? "text-amber-400/90" : "text-muted-foreground/80",
                          )}>
                            {sg.name}
                          </span>
                          {maint && <Wrench className="h-3 w-3 text-amber-400" />}
                          {queued.length > 0 && (
                            <span className="flex items-center gap-0.5 rounded bg-brand/15 px-1 py-0.5 text-[9px] font-semibold text-brand" title={`${queued.length} player(s) queued`}>
                              <Hourglass className="h-2.5 w-2.5" /> {queued.length}
                            </span>
                          )}
                          <span className="tabular-nums text-[10px] text-muted-foreground/60" title={`${online} players · ${running} server(s)${sg.slotLimit ? ` · cap ${sg.slotLimit}` : ""}`}>
                            {online}{sg.slotLimit ? `/${sg.slotLimit}` : ""}P · {running}S
                          </span>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuLabel>{group.name} / {sg.name}</ContextMenuLabel>
                          {queued.length > 0 && (
                            <ContextMenuItem onClick={() => setQueueView({ sg })}>
                              <Hourglass /> View queue ({queued.length})
                            </ContextMenuItem>
                          )}
                          <ContextMenuItem onClick={() => setDeployTo({ group, sg })}>
                            <Rocket /> Deploy server…
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => setSgFor({ group, parent: sg })}>
                            <FolderPlus /> New subgroup inside…
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => setSgSettings({ group, sg })}>
                            <Settings2 /> Settings…
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => toggleSgMaintenance(group, sg, !sg.maintenance)}>
                            <Wrench /> {sg.maintenance ? "Disable maintenance" : "Enable maintenance"}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem variant="destructive" onClick={() => delSubgroup(group, sg)}>
                            <Trash2 /> Delete subgroup
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                      {!sgCol && (
                        <div className="ml-3 space-y-px border-l border-hairline pl-1.5">
                          {sgTasks.length === 0 && children.length === 0 && (
                            <div className="px-2 py-1 text-[11px] text-muted-foreground/50">empty — drag a server here</div>
                          )}
                          {sgTasks.map((task) => taskRow(task, maint))}
                          {children.map((c) => renderSg(c, depth + 1))}
                        </div>
                      )}
                    </div>
                  );
                };

                const gKey = `g:${group.id}`;
                return (
                  <div key={group.id} className="mb-1">
                    <ContextMenu>
                      <ContextMenuTrigger
                        render={
                          <div
                            className={cn(
                              "group flex cursor-pointer items-center gap-1 rounded px-1.5 py-1.5 transition-colors hover:bg-accent/50",
                              dropTarget === gKey && "bg-brand/15 ring-1 ring-brand/50",
                            )}
                            onClick={() => setCollapsed((c) => ({ ...c, [group.id]: !c[group.id] }))}
                            {...dragProps(gKey, group.id, null)}
                          />
                        }
                      >
                        <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", isCol && "-rotate-90")} />
                        <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {group.name}
                        </span>
                        {group.maintenance && <Wrench className="h-3 w-3 text-amber-400" />}
                        <span className="text-[10px] text-muted-foreground/60">{group.tasks.length}</span>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuLabel>{group.name}</ContextMenuLabel>
                        <ContextMenuItem onClick={() => setDeployTo({ group })}>
                          <Rocket /> Deploy server…
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => setSgFor({ group })}>
                          <FolderPlus /> New subgroup…
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => setEditGroup(group)}>
                          <Settings2 /> Settings
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => toggleMaintenance(group, !group.maintenance)}>
                          <Wrench /> {group.maintenance ? "Disable maintenance" : "Enable maintenance"}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onClick={() => delGroup(group)}>
                          <Trash2 /> Delete group
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>

                    {!isCol && (
                      <div className="mt-0.5 space-y-px">
                        {loose.map((task) => taskRow(task, false))}
                        {sgs.filter((s) => !s.parentId).map((sg) => renderSg(sg, 0))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ---- Right detail panel ---- */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Select a server to manage it
              </div>
            ) : (
              <>
                <DetailHeader task={selected} group={selectedGroup} metrics={mByVmid} />
                <div className="flex gap-1 border-b border-hairline px-3">
                  {(["overview", "instances", ...(selected.role === "proxy" ? ["routing"] : []), ...(selected.softwareKind === "paper" ? ["world"] : []), "settings"] as Tab[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={cn(
                        "relative px-3 py-2.5 text-[13px] capitalize transition-colors",
                        tab === t ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t}
                      {tab === t && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto p-5">
                  {tab === "overview" && (
                    <OverviewTab task={selected} metrics={mByVmid} busy={!!pending[selected.id]} onScale={scale} />
                  )}
                  {tab === "instances" && (
                    <InstancesTab task={selected} metrics={mByVmid} connFresh={connFresh} pending={pending} onAction={instAction} onMigrate={migrate} onDelete={deleteInstance} nodes={nodeNames} />
                  )}
                  {tab === "routing" && selected.role === "proxy" && data && (
                    <RoutingTab
                      proxy={selected}
                      candidates={allTasks.filter((t) => t.role !== "proxy")}
                      busy={!!pending[selected.id]}
                      onSetFronts={setFronts}
                      onSetTryOrder={setTryOrder}
                      state={data}
                      metrics={metrics ?? null}
                    />
                  )}
                  {tab === "world" && selected.softwareKind === "paper" && (
                    <ShardingPanel taskId={selected.id} instanceCount={selected.running} taskMax={selected.max} />
                  )}
                  {tab === "settings" && (
                    <div className="space-y-4">
                      {verByTask.get(selected.id) && (
                        <VersionCard status={verByTask.get(selected.id)!} onChanged={() => { refreshVers(); refresh(); }} />
                      )}
                      <SettingsTab
                        task={selected}
                        frontCandidates={frontCandidates.filter((c) => c.id !== selected.id)}
                        taskNameById={taskNameById}
                        onSaved={refresh}
                        onDelete={() => delTask(selected)}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {editGroup && (
        <EditGroupDialog
          group={editGroup}
          open={!!editGroup}
          onOpenChange={(o) => { if (!o) setEditGroup(null); }}
          showTrigger={false}
          onSaved={() => { setEditGroup(null); refresh(); }}
        />
      )}
      {sgFor && (
        <NewSubgroupDialog
          groupId={sgFor.group.id}
          groupName={sgFor.group.name}
          parentId={sgFor.parent?.id}
          parentName={sgFor.parent?.name}
          open={!!sgFor}
          onOpenChange={(o) => { if (!o) setSgFor(null); }}
          onCreated={refresh}
        />
      )}
      {sgSettings && (
        <SubgroupSettingsDialog
          groupId={sgSettings.group.id}
          sg={sgSettings.sg}
          open={!!sgSettings}
          onOpenChange={(o) => { if (!o) setSgSettings(null); }}
          onSaved={refresh}
        />
      )}
      {queueView && (
        <QueueDialog
          sgName={queueView.sg.name}
          slotLimit={queueView.sg.slotLimit}
          players={queuesById.get(queueView.sg.id) ?? []}
          onClose={() => setQueueView(null)}
          onUnqueue={unqueue}
        />
      )}
      {deployTo && (
        <DeployServerDialog
          groupId={deployTo.group.id}
          groupName={deployTo.group.name}
          subgroupId={deployTo.sg?.id}
          subgroupName={deployTo.sg?.name}
          blueprints={data?.blueprints ?? []}
          open={!!deployTo}
          onOpenChange={(o) => { if (!o) setDeployTo(null); }}
          onDeployed={refresh}
        />
      )}
      {editTask && (
        <EditTaskDialog
          task={editTask}
          frontCandidates={frontCandidates.filter((c) => c.id !== editTask.id)}
          open={!!editTask}
          onOpenChange={(o) => { if (!o) setEditTask(null); }}
          showTrigger={false}
          onSaved={() => { setEditTask(null); refresh(); }}
        />
      )}
    </>
  );
}

/* ---- detail header ------------------------------------------------------- */
function DetailHeader({ task, group, metrics }: { task: Task; group: Group | null; metrics: Map<number, MetricRow> }) {
  const online = task.instances.reduce((n, i) => n + (metrics.get(i.vmid)?.online ?? 0), 0);
  const up = task.instances.some((i) => i.status === "running" && metrics.get(i.vmid)?.reachable);
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-md"
          style={{ background: `color-mix(in oklch, ${roleColor(task.role)} 16%, transparent)` }}
        >
          <ServerCog className="h-4.5 w-4.5" style={{ color: roleColor(task.role) }} />
        </div>
        <div>
          <div className="flex items-center gap-2 text-[15px] font-semibold">{task.name}</div>
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <RoleDot role={task.role} label />
            <span>·</span>
            <span>{task.softwareKind}{task.version ? ` ${task.version}` : ""}</span>
            {group && <><span>·</span><span>{group.name}</span></>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 text-right">
        {(task.maintenance || group?.maintenance || group?.subgroups?.some((s) => s.id === task.subgroupId && s.maintenance)) && (
          <span className="flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-400">
            <Wrench className="h-3 w-3" /> maintenance
          </span>
        )}
        <div>
          <div className="eyebrow">Players</div>
          <div className="text-sm font-semibold tabular-nums">{up ? online : "—"}</div>
        </div>
        <div>
          <div className="eyebrow">Instances</div>
          <div className="text-sm font-semibold tabular-nums">{task.running}/{task.desired}</div>
        </div>
        <span className={cn(
          "rounded px-2 py-1 text-[11px] font-medium",
          up ? "bg-emerald-500/15 text-emerald-400" : "bg-accent text-muted-foreground",
        )}>
          {up ? "online" : "offline"}
        </span>
      </div>
    </div>
  );
}

/* ---- overview tab -------------------------------------------------------- */
function OverviewTab({ task, metrics, busy, onScale }: { task: Task; metrics: Map<number, MetricRow>; busy: boolean; onScale: (t: Task, d: number) => void }) {
  const online = task.instances.reduce((n, i) => n + (metrics.get(i.vmid)?.online ?? 0), 0);
  const facts: [string, React.ReactNode][] = [
    ["Role", <RoleDot key="r" role={task.role} label />],
    ["Mode", task.mode],
    ["Software", `${task.softwareKind}${task.version ? ` ${task.version}` : ""}`],
    ["Port", task.port],
    ["Resources", `${task.cores} vCPU · ${task.memory} MB · ${task.disk} GB`],
    ["Persistent", task.persistent ? "yes" : "no (ephemeral)"],
    ["Players online", online],
    ["Autoscale", task.autoscale ? `${task.min}–${task.max || "∞"} · ~${task.playersPerInstance}/inst` : "off"],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="panel p-4">
        <div className="eyebrow mb-3">Configuration</div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
          {facts.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <dt className="text-[11px] text-muted-foreground">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="panel flex flex-col gap-4 p-4">
        <div>
          <div className="eyebrow mb-2">Scaling</div>
          <div className="flex items-center justify-between rounded-md bg-accent/50 px-3 py-2.5">
            <div className="text-sm">
              <span className="font-semibold tabular-nums">{task.running}</span>
              <span className="text-muted-foreground"> running · {task.live} live · want {task.desired}</span>
            </div>
            {task.autoscale ? (
              <span className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-brand">
                <InfinityIcon className="h-3 w-3" /> auto {task.min}–{task.max || "∞"}
              </span>
            ) : (
              <div className="flex items-center gap-1">
                <button className="flex h-7 w-7 items-center justify-center rounded border border-hairline text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30" disabled={busy || task.desired <= task.min} onClick={() => onScale(task, -1)}><Minus className="h-3.5 w-3.5" /></button>
                <span className="w-7 text-center text-sm font-semibold tabular-nums">{task.desired}</span>
                <button className="flex h-7 w-7 items-center justify-center rounded border border-hairline text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30" disabled={busy} onClick={() => onScale(task, +1)}><Plus className="h-3.5 w-3.5" /></button>
              </div>
            )}
          </div>
        </div>
        {task.motd && (
          <div>
            <div className="eyebrow mb-2">MOTD</div>
            <div className="rounded-md bg-accent/50 px-3 py-2 font-mono text-xs text-muted-foreground">{task.motd}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- instances tab ------------------------------------------------------- */
function InstancesTab({ task, metrics, connFresh, pending, onAction, onMigrate, onDelete, nodes }: {
  task: Task; metrics: Map<number, MetricRow>; connFresh: Set<number>; pending: Record<string, boolean>;
  onAction: (i: Instance, a: "start" | "shutdown" | "stop" | "reboot") => void;
  onMigrate: (i: Instance, target: string) => void;
  onDelete: (i: Instance) => Promise<void>;
  nodes: string[];
}) {
  const [del, setDel] = useState<Instance | null>(null);
  if (task.instances.length === 0) {
    return <div className="py-16 text-center text-sm text-muted-foreground">No instances running.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-hairline">
      <table className="w-full min-w-[520px] text-[13px]">
        <thead>
          <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-medium">Instance</th>
            <th className="px-3 py-2 font-medium">Node</th>
            <th className="px-3 py-2 font-medium">Address</th>
            <th className="px-3 py-2 font-medium">Players</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {task.instances.map((inst) => {
            const mr = metrics.get(inst.vmid);
            const live = inst.status === "running" && mr?.reachable;
            const busy = pending[`i${inst.vmid}`];
            return (
              <ContextMenu key={inst.vmid}>
                <ContextMenuTrigger
                  render={
                    <tr className="group border-b border-hairline last:border-0 hover:bg-accent/40" />
                  }
                >
                  <td className="px-3 py-2">
                    <a href={`/services/${inst.vmid}`} className="flex items-center gap-2 hover:text-brand">
                      {inst.status === "running" && inst.ready && (!CONNECTED_KINDS.has(task.softwareKind) || connFresh.has(inst.vmid)) ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      ) : inst.status === "running" ? (
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
                      )}
                      <span className="font-mono text-muted-foreground">#{inst.vmid}</span>
                      <span>{inst.name}</span>
                    </a>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{inst.node}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{inst.ip ?? "…dhcp"}</td>
                  <td className="px-3 py-2">
                    {live ? <span className="flex items-center gap-1 text-emerald-400"><Users className="h-3 w-3" />{mr!.online}/{mr!.max}</span> : <span className="text-muted-foreground/50">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {inst.status === "running" && !inst.ready ? (
                      <span className="flex items-center gap-1 text-amber-400"><Loader2 className="h-3 w-3 animate-spin" />installing</span>
                    ) : inst.status === "running" && CONNECTED_KINDS.has(task.softwareKind) && !connFresh.has(inst.vmid) ? (
                      // CT runs but the game server inside isn't heartbeating — restarting/booting
                      <span className="flex items-center gap-1 text-amber-400"><Loader2 className="h-3 w-3 animate-spin" />restarting…</span>
                    ) : inst.status === "running" ? (
                      <span className="flex items-center gap-1 text-emerald-400/80"><CheckCircle2 className="h-3 w-3" />ready</span>
                    ) : (
                      <StatusBadge status={inst.status} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {busy && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </td>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuLabel>#{inst.vmid} · {inst.name}</ContextMenuLabel>
                  <ContextMenuItem onClick={() => { window.location.href = `/services/${inst.vmid}`; }}><Terminal /> Console</ContextMenuItem>
                  <ContextMenuItem onClick={() => { window.location.href = `/services/${inst.vmid}?tab=files`; }}><FolderOpen /> Files</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onAction(inst, "start")}><Play /> Start</ContextMenuItem>
                  <ContextMenuItem onClick={() => onAction(inst, "reboot")}><RotateCw /> Reboot</ContextMenuItem>
                  <ContextMenuItem onClick={() => onAction(inst, "shutdown")}><Power /> Shutdown</ContextMenuItem>
                  {nodes.filter((n) => n !== inst.node).length > 0 && <ContextMenuSeparator />}
                  {nodes.filter((n) => n !== inst.node).map((n) => (
                    <ContextMenuItem key={n} onClick={() => onMigrate(inst, n)}><ArrowRightLeft /> Move to {n}</ContextMenuItem>
                  ))}
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => onAction(inst, "stop")}><Square /> Force stop</ContextMenuItem>
                  <ContextMenuItem variant="destructive" onClick={() => setDel(inst)}><Trash2 /> Delete instance…</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </tbody>
      </table>
      {del && (
        <ConfirmDeleteDialog
          open onOpenChange={(o) => !o && setDel(null)}
          title={`Delete instance #${del.vmid}`}
          confirmText={del.name}
          warning={`This permanently destroys the container ${del.name} (#${del.vmid}) and its disk${task.persistent ? " — including its world/data, which is NOT backed up" : ""}. The task target is lowered so it won't respawn. This cannot be undone.`}
          onConfirm={() => onDelete(del)}
        />
      )}
    </div>
  );
}

/* ---- routing tab (proxy) ------------------------------------------------- */
function RoutingTab({ proxy, candidates, busy, onSetFronts, onSetTryOrder, state, metrics }: {
  proxy: Task; candidates: Task[]; busy: boolean;
  onSetFronts: (p: Task, fronts: string[]) => void;
  onSetTryOrder: (p: Task, tryOrder: string[] | null) => void;
  state: State; metrics: Metrics | null;
}) {
  const fronted = new Set(proxy.fronts);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const toggle = (id: string) => {
    const next = new Set(fronted);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSetFronts(proxy, [...next]);
  };

  // Effective try list: explicit order, else the derived default (fronted lobby-role tasks).
  const explicit = (proxy.tryOrder ?? []).filter((id) => fronted.has(id));
  const derived = proxy.fronts.filter((id) => byId.get(id)?.role === "lobby");
  const tryList = explicit.length ? explicit : derived;
  const custom = explicit.length > 0;
  const addable = proxy.fronts.filter((id) => !tryList.includes(id) && byId.has(id));

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= tryList.length) return;
    const next = [...tryList];
    [next[i], next[j]] = [next[j], next[i]];
    onSetTryOrder(proxy, next);
  };

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="mb-1 flex items-center gap-2">
          <Network className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold">Backend routing</h3>
        </div>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Select which servers <span className="text-foreground">{proxy.name}</span> routes players to.
          Changes apply live via <span className="font-mono">velocity reload</span> — no player kicks.
        </p>
        <div className="space-y-1">
          {candidates.length === 0 && <p className="py-3 text-center text-xs text-muted-foreground">No backend servers to route to yet.</p>}
          {candidates.map((c) => {
            const on = fronted.has(c.id);
            return (
              <button
                key={c.id}
                disabled={busy}
                onClick={() => toggle(c.id)}
                className={cn(
                  "flex w-full items-center justify-between rounded-md border px-3 py-2 text-[13px] transition-colors disabled:opacity-50",
                  on ? "border-brand/40 bg-brand/10" : "border-hairline hover:bg-accent/50",
                )}
              >
                <span className="flex items-center gap-2"><RoleDot role={c.role} /> {c.name}</span>
                <span className={cn("text-[11px] font-medium", on ? "text-brand" : "text-muted-foreground")}>
                  {on ? "routed" : "not routed"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Fallback "try" order: where joins/kicks land, attempted top → bottom ── */}
      <div className="panel p-4">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ListOrdered className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-semibold">Fallback try order</h3>
          </div>
          {custom && (
            <button onClick={() => onSetTryOrder(proxy, null)} disabled={busy}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
              reset to default
            </button>
          )}
        </div>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Joining players (and kick-redirects, <span className="font-mono">/hub</span>) try these top
          to bottom — first live, non-full server wins. Put a <span className="text-foreground">Limbo</span> last
          as the never-fail catch-all.{!custom && " Currently the default order (fronted lobbies)."}
        </p>
        <div className="space-y-1">
          {tryList.length === 0 && <p className="py-3 text-center text-xs text-muted-foreground">Nothing in the try list — front a lobby (or Limbo) above.</p>}
          {tryList.map((id, i) => {
            const c = byId.get(id);
            if (!c) return null;
            return (
              <div key={id} className="flex items-center gap-2 rounded-md border border-hairline px-3 py-2 text-[13px]">
                <span className="w-5 text-center font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                <RoleDot role={c.role} />
                <span className="flex-1 truncate">{c.name}</span>
                {c.softwareKind === "limbo" && <span className="rounded bg-accent px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">limbo</span>}
                <button onClick={() => move(i, -1)} disabled={busy || i === 0} className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30">↑</button>
                <button onClick={() => move(i, 1)} disabled={busy || i === tryList.length - 1} className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30">↓</button>
                <button
                  onClick={() => onSetTryOrder(proxy, tryList.filter((x) => x !== id))}
                  disabled={busy || tryList.length <= 1}
                  title={tryList.length <= 1 ? "The try list needs at least one entry" : "Remove from the try list"}
                  className="rounded p-0.5 text-destructive/60 hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        {addable.length > 0 && (
          <select
            value=""
            disabled={busy}
            onChange={(e) => { if (e.target.value) onSetTryOrder(proxy, [...tryList, e.target.value]); }}
            className="mt-2 h-8 w-full rounded-md border border-hairline bg-transparent px-2 text-[13px] text-muted-foreground outline-none"
          >
            <option value="">+ add a routed server to the try list…</option>
            {addable.map((id) => <option key={id} value={id}>{byId.get(id)!.name}</option>)}
          </select>
        )}
      </div>

      <div className="panel overflow-hidden">
        <div className="border-b border-hairline px-4 py-2.5"><div className="eyebrow">Live topology</div></div>
        {/* No fixed height — the graph sizes to its content (height scales with node
            count) so every route stays visible at any screen width, never clipped. */}
        <FlowGraph state={state} metrics={metrics} />
      </div>
    </div>
  );
}

/* ---- settings tab -------------------------------------------------------- */
function SettingsTab({ task, frontCandidates, taskNameById, onSaved, onDelete }: {
  task: Task;
  frontCandidates: { id: string; name: string; role: string }[];
  taskNameById: Map<string, string>;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const frontsNames = task.fronts.map((id) => taskNameById.get(id) ?? id).join(", ");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="panel p-4">
        <div className="eyebrow mb-3">Configuration</div>
        <dl className="space-y-2.5 text-[13px]">
          <Row k="Resources" v={`${task.cores} vCPU · ${task.memory} MB · ${task.disk} GB`} />
          <Row k="Scaling" v={task.autoscale ? `auto ${task.min}–${task.max || "∞"}` : `manual · want ${task.desired} (min ${task.min}, max ${task.max || "∞"})`} />
          <Row k="Software" v={`${task.softwareKind}${task.version ? ` ${task.version}` : ""}`} />
          {task.role === "proxy" && <Row k="Routes" v={frontsNames || "none"} />}
        </dl>
        <div className="mt-4 flex items-center gap-2">
          <EditTaskDialog task={task} frontCandidates={frontCandidates} onSaved={onSaved} />
          {(task.softwareKind === "paper" || task.softwareKind === "velocity") && (
            <MotdDialog taskId={task.id} taskName={task.name} current={task.motd} players={0} max={0} onSaved={onSaved} />
          )}
        </div>
      </div>

      <div className="panel border-destructive/30 p-4">
        <div className="eyebrow mb-2 text-destructive/80">Danger zone</div>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Deleting this server stops and destroys all {task.live} instance(s). This cannot be undone.
        </p>
        <button
          onClick={onDelete}
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[13px] text-destructive transition-colors hover:bg-destructive/20"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete server
        </button>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}

/* ---- subgroup queue dialog ------------------------------------------------ */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Live view of a capped subgroup's join queue (admit order — priority first), with
 *  per-player remove. Player data refreshes with the connector poll while open. */
function QueueDialog({ sgName, slotLimit, players, onClose, onUnqueue }: {
  sgName: string;
  slotLimit?: number;
  players: { uuid: string; name: string; priority?: boolean }[];
  onClose: () => void;
  onUnqueue: (name: string) => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Hourglass className="h-4 w-4 text-brand" /> Queue · {sgName}
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {players.length} waiting{slotLimit ? ` · cap ${slotLimit}` : ""}
            </span>
          </DialogTitle>
          <DialogDescription>
            Admit order — <Star className="inline h-3 w-3 text-amber-400" /> priority (conduit.queue.priority)
            skips ahead. The proxy admits players automatically as slots free.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto py-1">
          {players.length === 0 && (
            <p className="player-empty-in py-6 text-center text-sm text-muted-foreground">Queue is empty.</p>
          )}
          {players.map((p, i) => (
            <div
              key={p.uuid}
              className="player-row-in flex items-center gap-2.5 rounded-md border border-hairline px-3 py-2"
              style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
            >
              <span className="w-6 text-center font-mono text-[11px] text-muted-foreground">#{i + 1}</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`https://mc-heads.net/avatar/${p.name}/20`} alt="" className="h-5 w-5 rounded-sm" />
              <span className="flex-1 truncate text-[13px]">{p.name}</span>
              {p.priority && <Star className="h-3.5 w-3.5 text-amber-400" />}
              <button
                onClick={() => onUnqueue(p.name)}
                className="rounded p-1 text-destructive/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
                title="Remove from queue"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---- empty state --------------------------------------------------------- */
function EmptyState({ onCreated }: { onCreated: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-hairline py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-accent">
        <ServerCog className="h-6 w-6 text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium">No server groups yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Create a group, then add servers from a blueprint.</p>
      </div>
      <NewGroupDialog onCreated={onCreated} />
    </div>
  );
}
