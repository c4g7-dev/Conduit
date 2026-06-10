"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { TargetPickerDialog, type PickGroup } from "@/components/target-picker-dialog";
import { cn } from "@/lib/utils";
import {
  Clock, RotateCw, Radio, Trash2, Plus, CalendarClock, Terminal, Archive, MoonStar, Crosshair, ChevronDown,
} from "lucide-react";

type ScheduleTarget =
  | { type: "group"; id: string }
  | { type: "subgroup"; groupId: string; id: string }
  | { type: "task"; id: string }
  | { type: "instance"; vmid: number };
type Schedule = {
  id: string; name: string; groupId?: string; target?: ScheduleTarget; targets?: ScheduleTarget[];
  action: "restart" | "command" | "broadcast" | "backup";
  at: string; command?: string; warnMins: number[]; onlyWhenEmpty?: boolean; backupStorage?: string;
  enabled: boolean; lastRun?: string;
};
type State = { groups: PickGroup[] };
type BackupStorage = { storage: string; type: string };

const ACTION_ICON = { restart: RotateCw, command: Terminal, broadcast: Radio, backup: Archive } as const;

/** Stable string key for a target (used for checkbox state + display lookups). */
const keyOf = (t: ScheduleTarget): string =>
  t.type === "group" ? `g:${t.id}` :
  t.type === "subgroup" ? `sg:${t.groupId}:${t.id}` :
  t.type === "task" ? `t:${t.id}` : `i:${t.vmid}`;

export default function SchedulesPage() {
  const { data, loading, refresh } = usePoll<{ schedules: Schedule[] }>("/api/schedules", 8000);
  const { data: state } = usePoll<State>("/api/conduit/state", 15000);
  const groups = useMemo(() => state?.groups ?? [], [state]);
  const [adding, setAdding] = useState(false);

  // Display labels for every addressable target.
  const labelByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) {
      m.set(`g:${g.id}`, g.name);
      for (const sg of g.subgroups ?? []) m.set(`sg:${g.id}:${sg.id}`, `${g.name} / ${sg.name}`);
      for (const t of g.tasks) {
        m.set(`t:${t.id}`, `${g.name} / ${t.name}`);
        for (const i of t.instances) m.set(`i:${i.vmid}`, `${t.name} #${i.vmid}`);
      }
    }
    return m;
  }, [groups]);

  const targetsOf = (s: Schedule): ScheduleTarget[] =>
    s.targets?.length ? s.targets : s.target ? [s.target] : s.groupId ? [{ type: "group", id: s.groupId }] : [];
  const targetSummary = (s: Schedule) => {
    const ts = targetsOf(s);
    if (ts.length === 0) return "—";
    const first = labelByKey.get(keyOf(ts[0])) ?? keyOf(ts[0]);
    return ts.length === 1 ? first : `${first} +${ts.length - 1}`;
  };

  // new-schedule form
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Map<string, ScheduleTarget>>(new Map());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [action, setAction] = useState<Schedule["action"]>("restart");
  const [at, setAt] = useState("04:00");
  const [command, setCommand] = useState("");
  const [warn, setWarn] = useState("5,1");
  const [onlyWhenEmpty, setOnlyWhenEmpty] = useState(false);

  // backup storages over the API (only shown for the backup action)
  const [storages, setStorages] = useState<BackupStorage[] | null>(null);
  const [backupStorage, setBackupStorage] = useState("");
  useEffect(() => {
    if (action !== "backup" || storages !== null) return;
    fetch("/api/backups").then((r) => r.json())
      .then((j) => {
        const list: BackupStorage[] = j.storages ?? [];
        setStorages(list);
        if (list.length && !backupStorage) setBackupStorage(list[0].storage);
      })
      .catch(() => setStorages([]));
  }, [action, storages, backupStorage]);

  const schedules = data?.schedules ?? [];

  async function create() {
    if (!name.trim()) return toast.error("Name required");
    if (picked.size === 0) return toast.error("Pick at least one target");
    try {
      const res = await fetch("/api/schedules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), targets: [...picked.values()], action, at,
          command: action === "command" || action === "broadcast" ? command : undefined,
          warnMins: warn.split(",").map((x) => Number(x.trim())).filter((n) => n > 0),
          onlyWhenEmpty: action === "restart" ? onlyWhenEmpty : undefined,
          backupStorage: action === "backup" ? backupStorage : undefined,
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      toast.success(`Scheduled "${name}"`);
      setAdding(false); setName(""); setCommand(""); setPicked(new Map());
      refresh();
    } catch (e) { toast.error(String(e)); }
  }

  async function toggle(s: Schedule) {
    await fetch(`/api/schedules/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) });
    refresh();
  }
  async function del(s: Schedule) {
    if (!confirm(`Delete schedule "${s.name}"?`)) return;
    await fetch(`/api/schedules/${s.id}`, { method: "DELETE" });
    toast.success("Schedule deleted"); refresh();
  }

  return (
    <>
      <PageHeader title="Schedules" subtitle="Automated restarts, commands and backups — run by the leader node" onRefresh={refresh} loading={loading}>
        <button onClick={() => setAdding((v) => !v)} className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> New schedule
        </button>
      </PageHeader>

      {adding && (
        <div className="panel mb-4 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="text-[11px] text-muted-foreground">Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly restart" className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-sm outline-none" />
            </label>
            <div className="col-span-2 text-[11px] text-muted-foreground">Targets
              <button
                onClick={() => setPickerOpen(true)}
                className="mt-1 flex w-full items-center gap-2 rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent/50"
              >
                <Crosshair className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {picked.size === 0 ? (
                  <span className="text-muted-foreground/60">Choose groups, services or instances…</span>
                ) : (
                  <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                    {[...picked.keys()].slice(0, 4).map((k) => (
                      <span key={k} className="rounded bg-accent px-1.5 py-0.5 text-[11px]">{labelByKey.get(k) ?? k}</span>
                    ))}
                    {picked.size > 4 && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px]">+{picked.size - 4}</span>}
                  </span>
                )}
                <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </div>
            <label className="text-[11px] text-muted-foreground">Action
              <select
                value={action}
                onChange={(e) => {
                  const a = e.target.value as Schedule["action"];
                  setAction(a);
                  // backups can't touch dynamic services — drop any already-picked ones
                  if (a === "backup") {
                    const dynTasks = new Set(groups.flatMap((g) => g.tasks.filter((t) => t.mode === "dynamic").map((t) => t.id)));
                    const dynVmids = new Set(groups.flatMap((g) => g.tasks.filter((t) => t.mode === "dynamic").flatMap((t) => t.instances.map((i) => i.vmid))));
                    setPicked((prev) => {
                      const next = new Map(prev);
                      for (const [k, t] of prev) {
                        if ((t.type === "task" && dynTasks.has(t.id)) || (t.type === "instance" && dynVmids.has(t.vmid))) next.delete(k);
                      }
                      return next.size === prev.size ? prev : next;
                    });
                  }
                }}
                className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-sm outline-none">
                <option value="restart">Restart</option>
                <option value="command">Command</option>
                <option value="backup">Backup</option>
              </select>
            </label>
            <label className="text-[11px] text-muted-foreground">Time (HH:MM)
              <input value={at} onChange={(e) => setAt(e.target.value)} className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-sm outline-none" />
            </label>
            {action === "restart" && (
              <>
                <label className="text-[11px] text-muted-foreground">Warn before (min, comma)
                  <input value={warn} onChange={(e) => setWarn(e.target.value)} placeholder="5,1" className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-sm outline-none" />
                </label>
                <label className="col-span-2 mt-5 flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
                  <input type="checkbox" checked={onlyWhenEmpty} onChange={(e) => setOnlyWhenEmpty(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--brand,#7c83ff)]" />
                  <MoonStar className="h-3.5 w-3.5" /> Restart only when empty (defer occupied instances until they clear)
                </label>
              </>
            )}
            {(action === "command" || action === "broadcast") && (
              <label className="col-span-2 text-[11px] text-muted-foreground">Console command
                <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="say Daily reminder!  /  save-all" className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-sm outline-none" />
              </label>
            )}
            {action === "backup" && (
              <label className="text-[11px] text-muted-foreground">Backup storage
                <select value={backupStorage} onChange={(e) => setBackupStorage(e.target.value)} className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-sm outline-none">
                  {storages === null && <option value="">loading storages…</option>}
                  {storages?.length === 0 && <option value="">no backup storages found</option>}
                  {storages?.map((s) => <option key={s.storage} value={s.storage}>{s.storage} ({s.type})</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="rounded-md border border-hairline px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50">Cancel</button>
            <button onClick={create} className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground hover:opacity-90">Create</button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline">
              {["", "Name", "Action", "Targets", "Time", "Last run", ""].map((h, i) => (
                <th key={h || i} className={cn("px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground", i === 6 ? "text-right" : "text-left")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => {
              const Icon = ACTION_ICON[s.action] ?? RotateCw;
              return (
                <tr key={s.id} className="group border-b border-hairline transition-colors last:border-0 hover:bg-accent/40">
                  <td className="px-4 py-2.5">
                    <button onClick={() => toggle(s)} title={s.enabled ? "Enabled" : "Disabled"}
                      className={cn("inline-flex h-4 w-7 items-center rounded-full transition-colors", s.enabled ? "bg-brand" : "bg-accent")}>
                      <span className={cn("h-3 w-3 rounded-full bg-white shadow transition-transform", s.enabled ? "translate-x-3.5" : "translate-x-0.5")} />
                    </button>
                  </td>
                  <td className="px-4 py-2.5 font-medium">{s.name}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Icon className="h-3.5 w-3.5" />
                      {s.action === "command" || s.action === "broadcast" ? <code className="text-xs">{s.command}</code>
                        : s.action === "backup" ? <span className="text-xs">→ {s.backupStorage}</span>
                        : <span className="text-xs">warn {s.warnMins.join(",")}m{s.onlyWhenEmpty ? " · when empty" : ""}</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground" title={targetsOf(s).map((t) => labelByKey.get(keyOf(t)) ?? keyOf(t)).join(", ")}>
                    <span className="font-mono text-xs">{targetSummary(s)}</span>
                  </td>
                  <td className="px-4 py-2.5"><span className="flex items-center gap-1 font-mono"><Clock className="h-3 w-3 text-muted-foreground" />{s.at}</span></td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{s.lastRun ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => del(s)} className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                  </td>
                </tr>
              );
            })}
            {schedules.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-muted-foreground">
                <CalendarClock className="mx-auto mb-2 h-6 w-6 opacity-40" />
                No schedules yet — automate restarts (per group, subgroup, service or instance), commands or backups.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pickerOpen && (
        <TargetPickerDialog
          groups={groups}
          picked={picked}
          onClose={() => setPickerOpen(false)}
          onSave={(next) => { setPicked(next); setPickerOpen(false); }}
          // Backups only make sense for STATIC services — dynamic ones are recreated on every
          // scale cycle, so their disks are throwaway.
          taskFilter={action === "backup" ? (t) => t.mode !== "dynamic" : undefined}
          filterNote={action === "backup" ? "Dynamic services are hidden — they're recreated on every scale cycle, only static ones can be backed up." : undefined}
        />
      )}
    </>
  );
}
