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
  const [pickVersion, setPickVersion] = useState("");

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
        // deliberately muted: the pinned version is intact and running — a newer full
        // version is information, not a problem.
        <div className="mt-3 rounded-md border border-hairline bg-accent/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <ArrowUpCircle className="h-4 w-4 shrink-0 text-muted-foreground/60" />
            <span className="text-[13px] text-muted-foreground">
              Newer version exists: <span className="font-mono text-foreground/80">{status.latestVersion}</span>
            </span>
            <button
              onClick={() => {
                if (confirm(`Switch ${status.name} to ${status.kind} ${status.latestVersion}? All running instances restart with the new jar. Worlds/configs stay; plugins may need updating for a new MC version.`)) {
                  post({ version: status.latestVersion }, "upgrade");
                }
              }}
              disabled={busy !== null}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {busy === "upgrade" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
              Upgrade to {status.latestVersion}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground/70">Full versions are never applied automatically — only on this explicit action.</p>
        </div>
      )}

      {!status.static && (
        <div className="mt-3">
          <button onClick={() => setPickOpen((o) => !o)} className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronDown className={cn("h-3 w-3 transition-transform", pickOpen && "rotate-180")} /> pin a different version
          </button>
          {pickOpen && (
            <div className="player-row-in mt-2 flex items-center gap-2">
              <select
                value={pickVersion}
                onChange={(e) => setPickVersion(e.target.value)}
                disabled={busy !== null}
                className="h-8 min-w-44 rounded-md border border-hairline bg-panel px-2 font-mono text-xs outline-none focus:border-brand/50"
              >
                <option value="">{versions.length === 0 ? "loading versions…" : "select a version…"}</option>
                {versions.map((v) => (
                  <option key={v} value={v}>
                    {v}{v === status.version ? "  (current)" : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  if (!pickVersion) return;
                  const same = pickVersion === status.version;
                  if (confirm(same
                    ? `Re-pin ${status.name} to ${status.kind} ${pickVersion} and reinstall its latest build? Running instances restart.`
                    : `Pin ${status.name} to ${status.kind} ${pickVersion} and install its latest build now? Running instances restart.`)) {
                    post({ version: pickVersion }, "pin");
                  }
                }}
                disabled={busy !== null || !pickVersion}
                className="flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                {busy === "pin" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
                {pickVersion && pickVersion === status.version ? "Pin" : "Pin & install"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
