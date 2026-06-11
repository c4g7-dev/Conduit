"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Server, Network, ShieldCheck, KeyRound, Loader2, Crosshair, Cable, ChevronDown, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { TargetPickerDialog, expandToTaskIds, type PickGroup, type PickTarget } from "@/components/target-picker-dialog";

type LpStatus = {
  connected: boolean; host: string | null; initialized: boolean;
  groups: number; users: number; tracks: number; messaging: string | null; error?: string;
};

export default function SettingsPage() {
  const { data: lp, refresh: refreshLp } = usePoll<LpStatus>("/api/luckperms/status", 10000);
  const { data: state } = usePoll<{ groups: PickGroup[] }>("/api/conduit/state", 15000);
  const groups = useMemo(() => state?.groups ?? [], [state]);
  const taskName = useMemo(() => new Map(groups.flatMap((g) => g.tasks.map((t) => [t.id, t.name] as const))), [groups]);
  const [installing, setInstalling] = useState(false);

  // managed install sets
  const { data: netData, refresh: refreshNet } = usePoll<{ connectorTasks: string[] | null; luckpermsTasks: string[] }>("/api/network", 15000);
  const { data: lpSetData, refresh: refreshLpSet } = usePoll<{ taskIds: string[] }>("/api/luckperms/install", 15000);
  const lpSet = lpSetData?.taskIds ?? [];
  const connectorSet = netData?.connectorTasks; // null = all (default)
  const [picker, setPicker] = useState<null | "lp" | "connector">(null);

  async function saveLpSet(ids: string[]) {
    setInstalling(true);
    try {
      const r = await fetch("/api/luckperms/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskIds: ids }) }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      const ok = (r.results ?? []).filter((x: { ok: boolean }) => x.ok).length;
      toast.success(`LuckPerms set saved — installed/refreshed on ${ok} instance(s)`);
      refreshLpSet(); refreshLp();
    } catch (e) { toast.error(String(e)); } finally { setInstalling(false); }
  }
  async function saveConnectorSet(ids: string[] | null) {
    const r = await fetch("/api/network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectorTasks: ids }) }).then((x) => x.json());
    if (r.error) return toast.error(r.error);
    toast.success(ids ? `Connector set to ${ids.length} service(s) — applies on next provision` : "Connector reset to all servers");
    refreshNet();
  }

  // player-history retention (days) — autosaves (debounced) on change, no save button
  const [retention, setRetention] = useState<number | null>(null);
  const [savingRetention, setSavingRetention] = useState(false);
  const retentionLoaded = useState({ done: false })[0];
  useEffect(() => {
    fetch("/api/audit?days=1").then((r) => r.json())
      .then((j) => { setRetention(j.retentionDays ?? 30); retentionLoaded.done = true; })
      .catch(() => { setRetention(30); retentionLoaded.done = true; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!retentionLoaded.done || retention === null || retention < 1 || retention > 365) return;
    const t = setTimeout(async () => {
      setSavingRetention(true);
      try {
        const r = await fetch("/api/audit", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retentionDays: retention }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
      } catch (e) { toast.error(String(e)); } finally { setSavingRetention(false); }
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retention]);

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

          {/* Managed install set — services that always have LuckPerms (reconcile keeps them synced) */}
          <div className="mt-4 space-y-2">
            <div className="text-[11px] font-medium text-muted-foreground">Servers with LuckPerms</div>
            <button
              onClick={() => setPicker("lp")}
              disabled={installing || !lp?.connected}
              className="flex w-full items-center gap-2 rounded-md border border-hairline bg-accent/30 px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-accent/50 disabled:opacity-50"
            >
              <Crosshair className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {lpSet.length === 0 ? <span className="text-muted-foreground/60">Choose servers…</span> : (
                <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {lpSet.slice(0, 6).map((id) => <span key={id} className="rounded bg-accent px-1.5 py-0.5 text-[11px]">{taskName.get(id) ?? id}</span>)}
                  {lpSet.length > 6 && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px]">+{lpSet.length - 6}</span>}
                </span>
              )}
              {installing ? <Loader2 className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin" /> : <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            </button>
            <p className="text-[11px] text-muted-foreground/70">New instances of these services get LuckPerms automatically. Changing the set installs on the new picks now.</p>
          </div>
        </div>

        {/* ── Conduit connector install set ────────────────────────────── */}
        <div className="panel p-5 sm:col-span-2">
          <div className="mb-3 flex items-center gap-2.5">
            <Cable className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold">Conduit connector · reporting servers</h2>
          </div>
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            The connector reports players/status to the panel and powers routing, moves and sharding.
            By default <span className="text-foreground">every</span> Paper/Velocity/Hytale server gets it —
            restrict it to specific services here (a server without it goes dark in the panel).
          </p>
          <button
            onClick={() => setPicker("connector")}
            className="flex w-full items-center gap-2 rounded-md border border-hairline bg-accent/30 px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-accent/50"
          >
            <Crosshair className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {connectorSet == null ? <span className="text-muted-foreground/60">All servers (default)</span> : connectorSet.length === 0 ? <span className="text-muted-foreground/60">All servers (default)</span> : (
              <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                {connectorSet.slice(0, 6).map((id) => <span key={id} className="rounded bg-accent px-1.5 py-0.5 text-[11px]">{taskName.get(id) ?? id}</span>)}
                {connectorSet.length > 6 && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px]">+{connectorSet.length - 6}</span>}
              </span>
            )}
            <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
          {connectorSet != null && (
            <button onClick={() => saveConnectorSet(null)} className="mt-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
              reset to all servers
            </button>
          )}
        </div>

        {/* ── Player audit ─────────────────────────────────────────────── */}
        <div className="panel p-5 sm:col-span-2">
          <div className="mb-3 flex items-center gap-2.5">
            <ShieldCheck className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold">Player history · retention</h2>
          </div>
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            Joins, quits, server switches and operator actions are logged per player. Entries
            older than the retention window are purged automatically; per-player erasure is
            available in each player&apos;s History dialog.
          </p>
          <div className="flex items-center gap-2">
            <input
              inputMode="numeric"
              value={retention ?? ""}
              onChange={(e) => setRetention(e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")))}
              className="w-20 rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-center font-mono text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="text-[12px] text-muted-foreground">days</span>
            {savingRetention && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
        </div>

        {/* ── System-service credentials (gated) ───────────────────────── */}
        <SystemCredentialsCard />

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

      {picker && (
        <TargetPickerDialog
          groups={groups}
          picked={new Map<string, PickTarget>(
            (picker === "lp" ? lpSet : (connectorSet ?? [])).map((id) => [`t:${id}`, { type: "task" as const, id }]),
          )}
          onClose={() => setPicker(null)}
          onSave={(sel) => {
            const ids = expandToTaskIds(groups, sel);
            if (picker === "lp") saveLpSet(ids); else saveConnectorSet(ids);
            setPicker(null);
          }}
          title={picker === "lp" ? "Servers with LuckPerms" : "Servers with the connector"}
          description="Pick services, or a group/subgroup. Static services expand to individual instances; dynamic ones are whole-service."
        />
      )}
    </>
  );
}

/* ---- system-service credentials: unlock gate → view + rotate -------------- */
type SysCreds = {
  redis: { user: string; password: string; endpoint: string | null; replicas: number; uses: string };
  postgres: { user: string; database: string; password: string; endpoint: string | null; uses: string };
  revealed: boolean;
};
function SystemCredentialsCard() {
  const [unlocked, setUnlocked] = useState(false);
  const [creds, setCreds] = useState<SysCreds | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(reveal: boolean) {
    const r = await fetch(`/api/system-credentials${reveal ? "?reveal=1" : ""}`).then((x) => x.json()).catch(() => null);
    setCreds(r);
  }
  function unlock() {
    if (!confirm("Reveal sensitive system-service credentials (Redis + Postgres passwords)? Make sure no one is shoulder-surfing.")) return;
    setUnlocked(true);
    load(true);
  }
  async function rotate(service: "redis" | "postgres") {
    if (!confirm(`Rotate the ${service} password? A new secret is generated and pushed to ${service === "redis" ? "the Redis cluster + every player-sync / LuckPerms consumer" : "Postgres + LuckPerms"}. Brief reconnect while it propagates.`)) return;
    setBusy(service);
    try {
      const r = await fetch("/api/system-credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service }) }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      toast.success(`${service} password rotated — propagating to consumers`);
      setTimeout(() => load(true), 1500);
    } catch (e) { toast.error(String(e)); } finally { setBusy(null); }
  }

  return (
    <div className="panel border-amber-500/20 p-5 sm:col-span-2">
      <div className="mb-1 flex items-center gap-2.5">
        <KeyRound className="h-4 w-4 text-amber-400" />
        <h2 className="text-sm font-semibold">System-service credentials</h2>
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">sensitive</span>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        Conduit owns the Redis (player-sync + LuckPerms messaging) and PostgreSQL (LuckPerms
        storage) credentials. Rotating one regenerates the secret and re-syncs it to every
        consumer automatically.
      </p>
      {!unlocked ? (
        <button onClick={unlock} className="flex items-center gap-2 rounded-md border border-amber-500/40 px-3 py-1.5 text-[13px] text-amber-400 transition-colors hover:bg-amber-500/10">
          <KeyRound className="h-3.5 w-3.5" /> Unlock to view &amp; rotate
        </button>
      ) : !creds ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            { svc: "redis" as const, title: "Redis · player sync", c: creds.redis, extra: `${creds.redis.replicas} replica(s)` },
            { svc: "postgres" as const, title: "PostgreSQL · LuckPerms", c: creds.postgres, extra: creds.postgres.database },
          ]).map(({ svc, title, c, extra }) => (
            <div key={svc} className="rounded-md border border-hairline bg-panel-2/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-semibold">{title}</span>
                <button onClick={() => rotate(svc)} disabled={busy !== null}
                  className="flex items-center gap-1 rounded border border-hairline px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
                  {busy === svc ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} rotate
                </button>
              </div>
              <dl className="space-y-1 text-[12px]">
                <Row k="Endpoint" v={c.endpoint ?? "—"} mono />
                <Row k="User" v={c.user} mono />
                <Row k="Password" v={c.password} mono />
                <Row k="Used for" v={c.uses} />
                <Row k={svc === "redis" ? "Replicas" : "Database"} v={extra} mono />
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className={cn("min-w-0 truncate text-right", mono && "font-mono text-[11px]")} title={v}>{v}</dd>
    </div>
  );
}
