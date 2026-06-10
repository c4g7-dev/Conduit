"use client";

import { useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { Clock, RotateCw, Radio, Trash2, Plus, CalendarClock } from "lucide-react";

type Schedule = {
  id: string; name: string; groupId: string; action: "restart" | "broadcast";
  at: string; command?: string; warnMins: number[]; enabled: boolean; lastRun?: string;
};
type State = { groups: { id: string; name: string }[] };

export default function SchedulesPage() {
  const { data, loading, refresh } = usePoll<{ schedules: Schedule[] }>("/api/schedules", 8000);
  const { data: state } = usePoll<State>("/api/conduit/state", 15000);
  const groups = state?.groups ?? [];
  const [adding, setAdding] = useState(false);

  // new-schedule form
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [action, setAction] = useState<"restart" | "broadcast">("restart");
  const [at, setAt] = useState("04:00");
  const [command, setCommand] = useState("");
  const [warn, setWarn] = useState("5,1");

  const schedules = data?.schedules ?? [];
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;

  async function create() {
    if (!name.trim() || !(groupId || groups[0]?.id)) return toast.error("Name + group required");
    try {
      const res = await fetch("/api/schedules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), groupId: groupId || groups[0].id, action, at,
          command: action === "broadcast" ? command : undefined,
          warnMins: warn.split(",").map((x) => Number(x.trim())).filter((n) => n > 0),
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      toast.success(`Scheduled "${name}"`);
      setAdding(false); setName(""); setCommand("");
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
      <PageHeader title="Schedules" subtitle="Automated restarts and broadcasts — run by the leader node" onRefresh={refresh} loading={loading}>
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
            <label className="text-[11px] text-muted-foreground">Group
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-sm outline-none">
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-muted-foreground">Action
              <select value={action} onChange={(e) => setAction(e.target.value as "restart" | "broadcast")} className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-sm outline-none">
                <option value="restart">Restart</option>
                <option value="broadcast">Broadcast</option>
              </select>
            </label>
            <label className="text-[11px] text-muted-foreground">Time (HH:MM)
              <input value={at} onChange={(e) => setAt(e.target.value)} className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-sm outline-none" />
            </label>
            {action === "restart" ? (
              <label className="text-[11px] text-muted-foreground">Warn before (min, comma)
                <input value={warn} onChange={(e) => setWarn(e.target.value)} placeholder="5,1" className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-sm outline-none" />
              </label>
            ) : (
              <label className="col-span-2 text-[11px] text-muted-foreground">Command
                <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="say Daily reminder!" className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-sm outline-none" />
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
              {["", "Name", "Action", "Group", "Time", "Last run", ""].map((h, i) => (
                <th key={h || i} className={cn("px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground", i === 6 ? "text-right" : "text-left")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
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
                    {s.action === "restart" ? <RotateCw className="h-3.5 w-3.5" /> : <Radio className="h-3.5 w-3.5" />}
                    {s.action === "broadcast" ? <code className="text-xs">{s.command}</code> : `warn ${s.warnMins.join(",")}m`}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{groupName(s.groupId)}</td>
                <td className="px-4 py-2.5"><span className="flex items-center gap-1 font-mono"><Clock className="h-3 w-3 text-muted-foreground" />{s.at}</span></td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{s.lastRun ?? "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => del(s)} className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                </td>
              </tr>
            ))}
            {schedules.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-muted-foreground">
                <CalendarClock className="mx-auto mb-2 h-6 w-6 opacity-40" />
                No schedules yet — automate nightly restarts or recurring broadcasts.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
