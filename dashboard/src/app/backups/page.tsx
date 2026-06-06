"use client";

import { useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bytes, pct } from "@/lib/format";
import { Archive, HardDrive, Clock, Trash2, Play, CalendarClock } from "lucide-react";

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
  ctime ? new Date(ctime * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export default function BackupsPage() {
  const { data, loading, refresh } = usePoll<Data>("/api/backups", 8000);
  const { data: gs } = usePoll<GroupsState>("/api/conduit/state", 8000);
  const groups = gs?.groups ?? [];

  const [pool, setPool] = useState("");
  const [storage, setStorage] = useState("");
  const [schedule, setSchedule] = useState("02:00");
  const [busy, setBusy] = useState(false);

  const storages = data?.storages ?? [];
  // prefer a PBS datastore as the backup target over plain local dir storage
  const defaultStorage =
    storage || storages.find((s) => s.type === "pbs")?.storage || storages[0]?.storage || "";

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

  return (
    <>
      <PageHeader
        title="Backups"
        subtitle="Proxmox Backup Server — on-demand + scheduled, deduplicated and incremental"
        onRefresh={refresh}
        loading={loading}
      >
        {storages.length > 1 && (
          <Select value={defaultStorage} onValueChange={(v) => setStorage(v ?? "")}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {storages.map((s) => (
                <SelectItem key={s.storage} value={s.storage}>
                  {s.storage}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </PageHeader>

      {/* storages */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {!data && loading &&
          Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-5 w-28" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-2 w-full" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))}
        {storages.map((s) => (
          <Card key={s.storage}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                {s.storage}
              </CardTitle>
              <Badge variant="secondary" className="uppercase">{s.type}</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {s.total ? <Progress value={pct(s.used ?? 0, s.total)} /> : null}
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{bytes(s.used ?? 0)} used</span>
                <span>{bytes(s.avail ?? 0)} free</span>
              </div>
            </CardContent>
          </Card>
        ))}
        {data && storages.length === 0 && (
          <Card className="border-dashed sm:col-span-2 lg:col-span-3">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No backup storage attached. Add a PBS datastore as Proxmox storage with
              content type <code className="rounded bg-muted px-1">backup</code>.
            </CardContent>
          </Card>
        )}
      </div>

      {/* scheduled jobs */}
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <CalendarClock className="h-4 w-4" /> Scheduled backups (per group)
      </h2>
      <Card className="mb-8">
        <CardContent className="space-y-3 py-1">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Group</label>
              <Select value={pool} onValueChange={(v) => setPool(v ?? "")}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Choose a group…" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Schedule (systemd calendar)</label>
              <Input className="w-40" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="02:00" />
            </div>
            <Button onClick={addJob} disabled={busy || !pool}>
              <CalendarClock className="h-4 w-4" /> Schedule
            </Button>
            {pool && (
              <Button variant="outline" onClick={() => backupNow(pool)} disabled={busy}>
                <Play className="h-4 w-4" /> Back up now
              </Button>
            )}
          </div>

          <div className="divide-y divide-border/50">
            {(data?.jobs ?? []).map((j) => (
              <div key={j.id} className="flex items-center justify-between py-2 text-sm">
                <span className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{j.pool ?? j.comment ?? j.id}</span>
                  <span className="text-muted-foreground">@ {j.schedule}</span>
                  <Badge variant="secondary" className="text-[10px]">{j.storage}</Badge>
                  {j.enabled === 0 && <Badge variant="outline" className="text-[10px]">disabled</Badge>}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => delJob(j.id)}
                  title="Remove schedule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {data && (data.jobs ?? []).length === 0 && (
              <p className="py-3 text-sm text-muted-foreground">
                No schedules yet — pick a group and a time above.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* recent backups */}
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Archive className="h-4 w-4" /> Recent snapshots
      </h2>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Guest</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.backups ?? []).map((b) => (
                <TableRow key={b.volid}>
                  <TableCell className="text-sm">{when(b.ctime)}</TableCell>
                  <TableCell className="font-medium">
                    {b.name ?? "—"}{" "}
                    {b.vmid != null && (
                      <span className="font-mono text-xs text-muted-foreground">#{b.vmid}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-[10px]">{b.storage}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{b.notes || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                    {bytes(b.size)}
                  </TableCell>
                </TableRow>
              ))}
              {!data && loading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))}
              {data && (data.backups ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    No backups yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
