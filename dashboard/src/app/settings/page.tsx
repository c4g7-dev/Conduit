"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Server, Network, ShieldCheck, KeyRound, Loader2, Download } from "lucide-react";
import { cn } from "@/lib/utils";

type LpStatus = {
  connected: boolean; host: string | null; initialized: boolean;
  groups: number; users: number; tracks: number; messaging: string | null; error?: string;
};

export default function SettingsPage() {
  const { data: lp, refresh: refreshLp } = usePoll<LpStatus>("/api/luckperms/status", 10000);
  const [installing, setInstalling] = useState(false);

  // DSGVO audit retention (days)
  const [retention, setRetention] = useState<number | null>(null);
  const [savingRetention, setSavingRetention] = useState(false);
  useEffect(() => {
    fetch("/api/audit?days=1").then((r) => r.json())
      .then((j) => setRetention(j.retentionDays ?? 30))
      .catch(() => setRetention(30));
  }, []);
  async function saveRetention() {
    if (retention === null) return;
    setSavingRetention(true);
    try {
      const r = await fetch("/api/audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: retention }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      toast.success(`Audit retention set to ${r.retentionDays} days`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingRetention(false);
    }
  }

  async function installLp() {
    if (!confirm("Install/refresh LuckPerms on every running Paper + Velocity instance? Each server restarts to load it.")) return;
    setInstalling(true);
    try {
      const res = await fetch("/api/luckperms/install", { method: "POST" });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      const ok = json.results.filter((r: { ok: boolean }) => r.ok).length;
      const bad = json.results.length - ok;
      toast.success(`LuckPerms installed on ${ok} instance(s)${bad ? ` — ${bad} failed` : ""}`);
      refreshLp();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Cluster, network and panel configuration" />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <Network className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold">Network</h2>
          </div>
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">VIP</dt>
              <dd className="font-mono">10.27.27.50</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Velocity forwarding</dt>
              <dd className="text-emerald-400">modern · configured</dd>
            </div>
          </dl>
        </div>

        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <Server className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold">Cluster</h2>
          </div>
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Nodes</dt>
              <dd>SkdCore01 · SkdCore02 · SkdCore03</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">State backend</dt>
              <dd className="font-mono text-xs">/etc/pve/conduit</dd>
            </div>
          </dl>
        </div>

        {/* ── LuckPerms (network permissions) ─────────────────────────── */}
        <div className="panel p-5 sm:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <KeyRound className="h-4 w-4 text-brand" />
              <h2 className="text-sm font-semibold">LuckPerms · network permissions</h2>
            </div>
            <span className={cn(
              "rounded px-2 py-0.5 text-[11px] font-medium",
              lp?.connected ? "bg-emerald-500/15 text-emerald-400" : "bg-accent text-muted-foreground",
            )}>
              {lp ? (lp.connected ? "connected" : "not connected") : "checking…"}
            </span>
          </div>
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            Permissions are stored on the Conduit-managed <span className="text-foreground">PostgreSQL</span> egg
            and sync instantly across all servers through the <span className="text-foreground">Redis</span> cluster.
            Maintenance bypass tiers (<code className="rounded bg-muted px-1">conduit.maintenance.bypass[.&lt;server&gt;]</code>)
            and queue priority resolve from here.
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
            <div className="flex flex-col gap-0.5">
              <dt className="text-[11px] text-muted-foreground">Storage</dt>
              <dd className="font-mono text-xs">{lp?.host ?? "—"}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-[11px] text-muted-foreground">Messaging</dt>
              <dd className="font-mono text-xs">{lp?.messaging ?? "—"}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-[11px] text-muted-foreground">Schema</dt>
              <dd>{lp?.initialized ? <span className="text-emerald-400">initialized</span> : <span className="text-muted-foreground">awaiting first boot</span>}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-[11px] text-muted-foreground">Data</dt>
              <dd className="tabular-nums">{lp?.initialized ? `${lp.groups} groups · ${lp.users} users · ${lp.tracks} tracks` : "—"}</dd>
            </div>
          </dl>
          {lp?.error && <p className="mt-2 text-[12px] text-amber-400/90">{lp.error}</p>}
          <div className="mt-4">
            <button
              onClick={installLp}
              disabled={installing || !lp?.connected}
              className="flex items-center gap-2 rounded-md border border-hairline px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {installing ? "Installing…" : "Install LuckPerms on all servers"}
            </button>
          </div>
        </div>

        {/* ── Player audit (DSGVO) ─────────────────────────────────────── */}
        <div className="panel p-5 sm:col-span-2">
          <div className="mb-3 flex items-center gap-2.5">
            <ShieldCheck className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold">Player audit · DSGVO retention</h2>
          </div>
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            Joins, quits, server switches and operator actions are logged per player (no chat,
            no message contents). Day files older than the retention window are purged
            automatically; per-player erasure is available in each player&apos;s History dialog.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} max={365}
              value={retention ?? ""}
              onChange={(e) => setRetention(Number(e.target.value))}
              className="w-24 rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-sm outline-none"
            />
            <span className="text-[12px] text-muted-foreground">days</span>
            <button
              onClick={saveRetention}
              disabled={retention === null || savingRetention}
              className="ml-2 flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {savingRetention ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Save retention
            </button>
          </div>
        </div>

        <div className="panel p-5 sm:col-span-2">
          <div className="mb-2 flex items-center gap-2.5">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">More settings</h2>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Per-server configuration lives on each server&apos;s Settings tab under{" "}
            <span className="text-foreground">Servers</span>. Additional panel options will appear here.
          </p>
        </div>
      </div>
    </>
  );
}
