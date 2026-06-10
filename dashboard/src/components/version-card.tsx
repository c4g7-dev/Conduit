"use client";

/**
 * Software version card for a server (ideas.md §1): current line + installed build, one-click
 * hotfix (newer build of the SAME line), auto-hotfix toggle, an explicit full-version switch
 * (never automatic), and a PIN toggle. Pinning deliberately locks the version → upgrade nudges
 * go muted; unpinning brings the prominent "new version" banner back. Hytale/static = display-only.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PackageCheck, ArrowUpCircle, Loader2, Zap, ChevronDown, Lock, LockOpen } from "lucide-react";

export type TaskVersionStatus = {
  taskId: string; name: string; kind: string; version: string;
  installedBuild?: number; latestBuild?: number; hotfixAvailable: boolean;
  latestVersion?: string; updateAvailable: boolean; autoUpdate: boolean; pinned: boolean; static?: boolean;
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

  // install / hotfix / version-switch / auto-hotfix go through the update route
  async function update(body: Record<string, unknown>, label: string) {
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

  // pin/unpin is a plain task flag — no reinstall
  async function setPinned(pinned: boolean) {
    setBusy("pin");
    try {
      const r = await fetch(`/api/tasks/${status.taskId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      toast.success(pinned ? `${status.name} pinned to ${status.version}` : `${status.name} unpinned`);
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }

  const muted = status.pinned; // pinned → upgrade nudges are informational, not alerts

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="eyebrow">Software version</div>
        {!status.static && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground" title="Automatically apply new builds of the current version (only restarts empty instances). New full versions are never auto-applied.">
            <input
              type="checkbox"
              checked={status.autoUpdate}
              disabled={busy !== null}
              onChange={(e) => update({ autoUpdate: e.target.checked }, "auto")}
              className="h-3.5 w-3.5 accent-[var(--brand,#7c83ff)]"
            />
            <Zap className="h-3 w-3" /> auto-hotfix
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">Version</span>
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
              onClick={() => update({ hotfix: true }, "hotfix")}
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
          {!status.static && (
            <button
              onClick={() => setPinned(!status.pinned)}
              disabled={busy !== null}
              title={status.pinned ? "Unpin — show new-version nudges again" : "Pin this version — stop nudging about newer full versions"}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50",
                status.pinned
                  ? "bg-brand/15 text-brand hover:bg-brand/25"
                  : "border border-hairline text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {busy === "pin" ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : status.pinned ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
              {status.pinned ? "Unpin" : "Pin"}
            </button>
          )}
        </div>
      </div>

      {status.updateAvailable && (
        // not pinned → prominent yellow nudge; pinned → muted (deliberately locked).
        <div className={cn(
          "mt-3 rounded-md border p-3",
          muted ? "border-hairline bg-accent/30" : "border-yellow-500/30 bg-yellow-500/[0.07]",
        )}>
          <div className="flex flex-wrap items-center gap-2">
            <ArrowUpCircle className={cn("h-4 w-4 shrink-0", muted ? "text-muted-foreground/60" : "text-yellow-400")} />
            <span className={cn("text-[13px]", muted ? "text-muted-foreground" : "text-foreground")}>
              {muted ? "Pinned · newer version exists: " : "New version available: "}
              <span className={cn("font-mono", muted ? "text-foreground/80" : "font-semibold text-yellow-400")}>{status.latestVersion}</span>
            </span>
            <button
              onClick={() => {
                if (confirm(`Switch ${status.name} to ${status.kind} ${status.latestVersion}? All running instances restart with the new jar. Worlds/configs stay; plugins may need updating for a new MC version.`)) {
                  update({ version: status.latestVersion }, "upgrade");
                }
              }}
              disabled={busy !== null}
              className={cn(
                "ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50",
                muted
                  ? "border border-hairline text-muted-foreground hover:bg-accent hover:text-foreground"
                  : "bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25",
              )}
            >
              {busy === "upgrade" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
              Upgrade to {status.latestVersion}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground/70">
            {muted ? "Unpin to be nudged about new versions. " : ""}Full versions are never applied automatically — only on this explicit action.
          </p>
        </div>
      )}

      {!status.static && (
        <div className="mt-3">
          <button onClick={() => setPickOpen((o) => !o)} className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronDown className={cn("h-3 w-3 transition-transform", pickOpen && "rotate-180")} /> switch to a different version
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
                    ? `Reinstall ${status.kind} ${pickVersion}'s latest build on ${status.name}? Running instances restart.`
                    : `Switch ${status.name} to ${status.kind} ${pickVersion} and install its latest build now? Running instances restart.`)) {
                    update({ version: pickVersion }, "switch");
                  }
                }}
                disabled={busy !== null || !pickVersion}
                className="flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                {busy === "switch" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
                {pickVersion && pickVersion === status.version ? "Reinstall" : "Switch & install"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
