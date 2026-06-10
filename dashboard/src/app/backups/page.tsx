"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { bytes, pct } from "@/lib/format";
import {
  Archive,
  HardDrive,
  Clock,
  Trash2,
  Play,
  CalendarClock,
  RotateCcw,
  AlertCircle,
} from "lucide-react";

type Storage = {
  storage: string;
  type: string;
  total?: number;
  used?: number;
  avail?: number;
};
type Backup = {
  volid: string;
  storage: string;
  vmid: number | null;
  name: string | null;
  ctime: number;
  size: number;
  notes: string;
};
type Job = {
  id: string;
  schedule?: string;
  storage?: string;
  pool?: string;
  enabled?: number;
  comment?: string;
};
type Data = { storages: Storage[]; backups: Backup[]; jobs: Job[] };
type Group = { id: string; name: string };
type GroupsState = { groups: Group[] };

const when = (ctime: number) =>
  ctime
    ? new Date(ctime * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-white/35">
      {children}
    </div>
  );
}

export default function BackupsPage() {
  const { data, loading, refresh } = usePoll<Data>("/api/backups", 8000);
  const { data: gs } = usePoll<GroupsState>("/api/conduit/state", 8000);
  const groups = gs?.groups ?? [];

  const [pool, setPool] = useState("");
  const [storage, setStorage] = useState("");
  const [schedule, setSchedule] = useState("02:00");
  const [busy, setBusy] = useState(false);

  const storages = data?.storages ?? [];
  const defaultStorage =
    storage || storages.find((s) => s.type === "pbs")?.storage || storages[0]?.storage || "";

  const allBackups = data?.backups ?? [];
  const displayedBackups = storage ? allBackups.filter((b) => b.storage === storage) : allBackups;

  useEffect(() => {
    if (groups.length === 1 && !pool) setPool(groups[0].id);
  }, [groups, pool]);

  async function backupNow(poolId: string) {
    if (!defaultStorage) return toast.error("no backup storage available");
    setBusy(true);
    try {
      const res = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool: poolId, storage: defaultStorage }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Backup of "${poolId}" started → ${defaultStorage}`);
      setTimeout(refresh, 4000);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addJob() {
    if (!pool || !defaultStorage) return toast.error("pick a group and storage");
    setBusy(true);
    try {
      const res = await fetch("/api/backups/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool, storage: defaultStorage, schedule }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Scheduled "${pool}" @ ${schedule} → ${defaultStorage}`);
      setPool("");
      refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function delJob(id: string) {
    await fetch(`/api/backups/jobs/${id}`, { method: "DELETE" });
    toast.success("Schedule removed");
    refresh();
  }

  async function delBackup(b: Backup) {
    if (!confirm(`Delete this snapshot of ${b.name ?? "#" + b.vmid} from ${when(b.ctime)}?`))
      return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/backups?volid=${encodeURIComponent(b.volid)}&storage=${encodeURIComponent(b.storage)}`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success("Snapshot deleted");
      refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restore(b: Backup) {
    if (b.vmid == null) return;
    if (
      !confirm(
        `Restore ${b.name ?? "#" + b.vmid} (#${b.vmid}) from the snapshot of ${when(b.ctime)}?\n\nThis OVERWRITES the current container — it will be stopped, rolled back, and restarted.`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volid: b.volid, vmid: b.vmid }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Restored #${b.vmid} — restarting`);
      setTimeout(refresh, 4000);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Backups"
        subtitle="Proxmox Backup Server — on-demand + scheduled, deduplicated and incremental"
        onRefresh={refresh}
        loading={loading}
      >
        {storages.length > 1 && (
          <div className="flex overflow-hidden rounded-lg border border-white/[0.08]">
            <button
              onClick={() => setStorage("")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                !storage ? "bg-white/[0.08] text-white" : "text-white/30 hover:text-white/60"
              }`}
            >
              All
            </button>
            {storages.map((s) => (
              <button
                key={s.storage}
                onClick={() => setStorage(s.storage)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  storage === s.storage
                    ? "bg-white/[0.08] text-white"
                    : "text-white/30 hover:text-white/60"
                }`}
              >
                {s.storage}
              </button>
            ))}
          </div>
        )}
      </PageHeader>

      {/* Storage cards */}
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!data &&
          loading &&
          Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl border border-white/[0.07] bg-white/[0.03]"
            />
          ))}
        {storages.map((s) => {
          const usedPct = s.total ? pct(s.used ?? 0, s.total) : 0;
          const fillColor =
            usedPct > 85 ? "#f87171" : usedPct > 65 ? "#fb923c" : "#34d399";
          return (
            <div
              key={s.storage}
              className="overflow-hidden rounded-xl border border-white/[0.07] bg-panel p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4 text-white/30" />
                  <span className="font-semibold text-white">{s.storage}</span>
                </div>
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium uppercase text-white/40">
                  {s.type}
                </span>
              </div>
              {s.total ? (
                <div className="mt-3">
                  <div className="mb-1.5 flex justify-between text-[11px] text-white/30">
                    <span>{bytes(s.used ?? 0)} used</span>
                    <span>{bytes(s.avail ?? 0)} free</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${usedPct}%`, background: fillColor }}
                    />
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-white/25">No size info available</p>
              )}
            </div>
          );
        })}
        {data && storages.length === 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-white/[0.08] px-4 py-8 text-sm text-white/25 sm:col-span-2 lg:col-span-3">
            <AlertCircle className="h-4 w-4 shrink-0" />
            No backup storage attached. Add a PBS datastore as Proxmox storage with content type{" "}
            <code className="rounded bg-white/[0.06] px-1">backup</code>.
          </div>
        )}
      </div>

      {/* Scheduled jobs */}
      <div className="mb-2 flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-white/30" />
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-white/40">
          Scheduled backups
        </h2>
      </div>
      <div className="mb-8 overflow-hidden rounded-xl border border-white/[0.07] bg-panel">
        <div className="flex flex-wrap items-end gap-3 border-b border-white/[0.06] bg-white/[0.02] p-4">
          <div>
            <FieldLabel>Group</FieldLabel>
            {groups.length <= 4 ? (
              <div className="flex overflow-hidden rounded-lg border border-white/[0.08]">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => setPool(g.id)}
                    disabled={groups.length <= 1}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                      pool === g.id
                        ? "bg-white/[0.08] text-white"
                        : "text-white/30 hover:text-white/60"
                    }`}
                  >
                    {g.name}
                  </button>
                ))}
                {groups.length === 0 && (
                  <span className="px-3 py-1.5 text-xs text-white/20">No groups</span>
                )}
              </div>
            ) : (
              <select
                value={pool}
                onChange={(e) => setPool(e.target.value)}
                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 outline-none"
              >
                <option value="">Choose group…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <FieldLabel>Schedule (systemd calendar)</FieldLabel>
            <input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="02:00"
              className="w-32 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-white/80 outline-none placeholder:text-white/20 focus:border-white/[0.15]"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={addJob}
              disabled={busy || !pool}
              className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-40"
            >
              <CalendarClock className="h-3.5 w-3.5" /> Schedule
            </button>
            {pool && (
              <button
                onClick={() => backupNow(pool)}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" /> Back up now
              </button>
            )}
          </div>
        </div>

        <div className="divide-y divide-white/[0.04]">
          {(data?.jobs ?? []).map((j) => (
            <div key={j.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3 text-sm">
                <Clock className="h-3.5 w-3.5 shrink-0 text-white/25" />
                <span className="font-medium text-white/70">{j.pool ?? j.comment ?? j.id}</span>
                <span className="text-white/30">@ {j.schedule}</span>
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/40">
                  {j.storage}
                </span>
                {j.enabled === 0 && (
                  <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
                    disabled
                  </span>
                )}
              </div>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-red-400/40 transition-colors hover:bg-red-500/10 hover:text-red-400"
                onClick={() => delJob(j.id)}
                title="Remove schedule"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {data && (data.jobs ?? []).length === 0 && (
            <p className="px-4 py-4 text-sm text-white/25">
              No schedules yet — pick a group and time above.
            </p>
          )}
        </div>
      </div>

      {/* Recent snapshots */}
      <div className="mb-2 flex items-center gap-2">
        <Archive className="h-4 w-4 text-white/30" />
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-white/40">
          Recent snapshots
        </h2>
      </div>
      <div className="overflow-hidden rounded-xl border border-white/[0.07]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              {["When", "Guest", "Storage", "Notes", "Size", ""].map((h, i) => (
                <th
                  key={h || i}
                  className={`px-4 py-2.5 text-[11px] font-medium uppercase tracking-widest text-white/30 ${
                    i >= 4 ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayedBackups.map((b) => (
              <tr
                key={b.volid}
                className="border-b border-white/[0.03] transition-colors hover:bg-white/[0.02] last:border-b-0"
              >
                <td className="px-4 py-3 text-xs tabular-nums text-white/50">{when(b.ctime)}</td>
                <td className="px-4 py-3">
                  <span className="font-medium text-white/70">{b.name ?? "—"}</span>
                  {b.vmid != null && (
                    <span className="ml-1.5 font-mono text-[11px] text-white/25">#{b.vmid}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/40">
                    {b.storage}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-white/30">{b.notes || "—"}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-white/30">
                  {bytes(b.size)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <button
                      disabled={busy || b.vmid == null}
                      onClick={() => restore(b)}
                      className="flex items-center gap-1.5 rounded-md border border-white/[0.07] px-2 py-1 text-[11px] text-white/40 transition-colors hover:border-sky-500/30 hover:bg-sky-500/10 hover:text-sky-300 disabled:opacity-30"
                      title="Restore this snapshot"
                    >
                      <RotateCcw className="h-3 w-3" /> Restore
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => delBackup(b)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-red-400/40 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30"
                      title="Delete this snapshot"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!data &&
              loading &&
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-white/[0.03]">
                  <td colSpan={6} className="px-4 py-3">
                    <div className="h-4 animate-pulse rounded bg-white/[0.04]" />
                  </td>
                </tr>
              ))}
            {data && displayedBackups.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-white/25">
                  {storage && allBackups.length > 0
                    ? `No backups in "${storage}" — pick a different storage above.`
                    : "No backups yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
