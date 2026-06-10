"use client";

/**
 * Software version card for a server (ideas.md §1): pinned line + installed build, one-click
 * hotfix (newer build of the SAME line), auto-hotfix toggle, and explicit full-version switch
 * (never automatic). Hytale/static kinds render version-only.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PackageCheck, ArrowUpCircle, Loader2, Zap, ChevronDown } from "lucide-react";

export type TaskVersionStatus = {
  taskId: string; name: string; kind: string; version: string;
  installedBuild?: number; latestBuild?: number; hotfixAvailable: boolean;
  latestVersion?: string; updateAvailable: boolean; autoUpdate: boolean; static?: boolean;
};

export function VersionCard({ status, onChanged }: { status: TaskVersionStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [pickOpen, setPickOpen] = useState(false);

  useEffect(() => {
    if (!pickOpen || versions.length) return;
    fetch(`/api/versions?kind=${status.kind}`).then((r) => r.json()).then((j) => setVersions(j.versions ?? [])).catch(() => {});
  }, [pickOpen, versions.length, status.kind]);

  async function post(body: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      const r = await fetch(`/api/tasks/${status.taskId}/update`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      toast.success(
        body.autoUpdate !== undefined
          ? `Auto-hotfix ${body.autoUpdate ? "enabled" : "disabled"}`
          : `${status.name}: ${j.version} build ${j.build} applied to ${j.results?.filter((x: { ok: boolean }) => x.ok).length ?? 0} instance(s)`,
      );
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="eyebrow">Software version</div>
        {!status.static && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground" title="Automatically apply new builds of the pinned version (only restarts empty instances). New full versions are never auto-applied.">
            <input
              type="checkbox"
              checked={status.autoUpdate}
              disabled={busy !== null}
              onChange={(e) => post({ autoUpdate: e.target.checked }, "auto")}
              className="h-3.5 w-3.5 accent-[var(--brand,#7c83ff)]"
            />
            <Zap className="h-3 w-3" /> auto-hotfix
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">Pinned</span>
          <span className="font-mono font-medium">{status.kind} {status.version}</span>
        </div>
        {!status.static && (
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">Build</span>
            <span className="font-mono">
              {status.installedBuild ?? "?"}
              {status.latestBuild != null && (
                <span className={cn("ml-1", status.hotfixAvailable ? "text-amber-400" : "text-muted-foreground/60")}>
                  / {status.latestBuild}
                </span>
              )}
            </span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {status.hotfixAvailable && (
            <button
              onClick={() => post({ hotfix: true }, "hotfix")}
              disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2.5 py-1.5 text-[12px] font-medium text-amber-400 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
            >
              {busy === "hotfix" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
              Apply hotfix → #{status.latestBuild}
            </button>
          )}
          {!status.hotfixAvailable && !status.updateAvailable && !status.static && (
            <span className="flex items-center gap-1 text-[12px] text-emerald-400/80"><PackageCheck className="h-3.5 w-3.5" /> up to date</span>
          )}
        </div>
      </div>

      {status.updateAvailable && (
        <div className="mt-3 rounded-md border border-brand/30 bg-brand/[0.06] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <ArrowUpCircle className="h-4 w-4 shrink-0 text-brand" />
            <span className="text-[13px]">
              New version available: <span className="font-mono font-semibold text-brand">{status.latestVersion}</span>
            </span>
            <button
              onClick={() => {
                if (confirm(`Switch ${status.name} to ${status.kind} ${status.latestVersion}? All running instances restart with the new jar. Worlds/configs stay; plugins may need updating for a new MC version.`)) {
                  post({ version: status.latestVersion }, "upgrade");
                }
              }}
              disabled={busy !== null}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-brand/15 px-2.5 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand/25 disabled:opacity-50"
            >
              {busy === "upgrade" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
              Upgrade to {status.latestVersion}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Full versions are never applied automatically — only on this explicit action.</p>
        </div>
      )}

      {!status.static && (
        <div className="mt-3">
          <button onClick={() => setPickOpen((o) => !o)} className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronDown className={cn("h-3 w-3 transition-transform", pickOpen && "rotate-180")} /> pin a different version
          </button>
          {pickOpen && (
            <div className="player-row-in mt-2 flex flex-wrap gap-1">
              {versions.length === 0 && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              {versions.slice(0, 16).map((v) => (
                <button
                  key={v}
                  disabled={busy !== null || v === status.version}
                  onClick={() => {
                    if (confirm(`Pin ${status.name} to ${status.kind} ${v} and install its latest build now?`)) post({ version: v }, "pin");
                  }}
                  className={cn(
                    "rounded border px-2 py-0.5 font-mono text-[11px] transition-colors",
                    v === status.version ? "border-brand/50 bg-brand/10 text-brand" : "border-hairline text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
