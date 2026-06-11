"use client";

/**
 * Live template/overlay file-sync progress — shows what auto file-sync (and manual re-syncs)
 * are copying: per service, the overlay size + file count, an overall progress bar with ETA,
 * and per-instance status grouped by node. Polls /api/sync-status (fast while anything is
 * active; the section hides itself when idle).
 */
import { useMemo } from "react";
import { usePoll } from "@/hooks/use-poll";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FolderSync, Zap, Hand, CheckCircle2, Loader2, XCircle, Server } from "lucide-react";

type SyncInstance = { vmid: number; node: string; status: "pending" | "copying" | "done" | "error"; error?: string; startedAt?: number; finishedAt?: number };
type SyncJob = {
  id: string; taskId: string; taskName: string; trigger: "manual" | "auto"; restart: boolean;
  bytes: number; files: number; startedAt: number; finishedAt?: number; instances: SyncInstance[];
};

function eta(job: SyncJob): string {
  const done = job.instances.filter((i) => i.status === "done" || i.status === "error").length;
  const total = job.instances.length;
  if (done >= total) return "done";
  if (done === 0) return "…";
  const elapsed = Date.now() - job.startedAt;
  const perInst = elapsed / done;
  const remainMs = perInst * (total - done);
  const s = Math.ceil(remainMs / 1000);
  return s < 60 ? `~${s}s left` : `~${Math.ceil(s / 60)}m left`;
}

export function SyncProgressSection({ poll = 1200 }: { poll?: number }) {
  const { data } = usePoll<{ syncs: SyncJob[] }>("/api/sync-status", poll);
  const syncs = useMemo(() => (data?.syncs ?? []).slice().reverse(), [data]); // newest first
  if (syncs.length === 0) return null;

  return (
    <>
      <div className="mb-3 mt-8 flex items-center gap-2">
        <FolderSync className="h-4 w-4 text-brand" />
        <h2 className="eyebrow">Template file sync · live</h2>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {syncs.map((job) => {
          const done = job.instances.filter((i) => i.status === "done").length;
          const errored = job.instances.filter((i) => i.status === "error").length;
          const total = job.instances.length;
          const pct = total ? Math.round(((done + errored) / total) * 100) : 100;
          const active = !job.finishedAt;
          // group instances by node
          const byNode = new Map<string, SyncInstance[]>();
          for (const i of job.instances) {
            const list = byNode.get(i.node) ?? [];
            list.push(i);
            byNode.set(i.node, list);
          }

          return (
            <div key={job.id} className={cn("rounded-lg border bg-panel p-4 transition-colors", active ? "border-brand/40" : "border-hairline")}>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {job.trigger === "auto" ? <><Zap className="h-2.5 w-2.5" /> auto</> : <><Hand className="h-2.5 w-2.5" /> manual</>}
                </span>
                <span className="truncate font-semibold">{job.taskName}</span>
                {job.restart && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-400">+restart</span>}
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{active ? eta(job) : "complete"}</span>
              </div>

              <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
                <span>{bytes(job.bytes)}</span>
                <span>{job.files} file{job.files === 1 ? "" : "s"}</span>
                <span className="ml-auto tabular-nums">{done + errored}/{total} instance(s)</span>
              </div>

              {/* overall progress */}
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-accent">
                <div className={cn("h-full rounded-full transition-all", errored ? "bg-amber-400" : active ? "bg-brand" : "bg-emerald-500")} style={{ width: `${pct}%` }} />
              </div>

              {/* per-node instance rows */}
              <div className="mt-3 space-y-2">
                {[...byNode.entries()].map(([node, insts]) => (
                  <div key={node}>
                    <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      <Server className="h-3 w-3" /> {node}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {insts.map((i) => (
                        <span key={i.vmid} title={i.error ?? i.status}
                          className={cn("flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
                            i.status === "done" ? "border-emerald-500/30 text-emerald-400"
                            : i.status === "copying" ? "border-brand/40 text-brand"
                            : i.status === "error" ? "border-amber-500/40 text-amber-400"
                            : "border-hairline text-muted-foreground/60")}>
                          {i.status === "done" ? <CheckCircle2 className="h-3 w-3" />
                            : i.status === "copying" ? <Loader2 className="h-3 w-3 animate-spin" />
                            : i.status === "error" ? <XCircle className="h-3 w-3" />
                            : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />}
                          #{i.vmid}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
