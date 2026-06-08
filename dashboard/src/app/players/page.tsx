"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { RoleDot } from "@/components/role-dot";
import { cn } from "@/lib/utils";
import { Users, Send, UserX, Radio, Loader2 } from "lucide-react";

type MetricRow = {
  vmid: number; taskName: string; role: string; reachable: boolean;
  online: number; max: number; sample: string[];
};
type Metrics = { instances: MetricRow[]; totals: { players: number; capacity: number } };
type StTask = { softwareKind: string; name: string; instances: { vmid: number; status: string; ready: boolean }[] };
type State = { groups: { id: string; name: string; tasks: StTask[] }[] };

type PlayerRow = { name: string; server: string; vmid: number; role: string };

// Software kinds that represent a game/player service (vs db/web/generic).
const GAME_KINDS = new Set(["paper", "velocity", "hytale"]);
// Kinds we can enumerate live players for (Minecraft SLP). Hytale has no public query yet.
const QUERYABLE = new Set(["paper", "velocity"]);

export default function PlayersPage() {
  const { data: metrics, loading, refresh } = usePoll<Metrics>("/api/metrics", 5000);
  const { data: state } = usePoll<State>("/api/conduit/state", 10000);
  const [cmd, setCmd] = useState("");
  const [groupId, setGroupId] = useState("__all");
  const [busy, setBusy] = useState(false);
  const [kicking, setKicking] = useState<string | null>(null);

  // Build the player → server map from backend SLP samples (backends attribute a player
  // to a specific server; the proxy sample would only give the network total).
  const players = useMemo<PlayerRow[]>(() => {
    const rows = (metrics?.instances ?? []).filter((r) => r.role !== "proxy" && r.reachable);
    const out: PlayerRow[] = [];
    for (const r of rows) for (const name of r.sample ?? []) out.push({ name, server: r.taskName, vmid: r.vmid, role: r.role });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [metrics]);

  const groups = state?.groups ?? [];
  const total = metrics?.totals.players ?? 0;
  const capacity = metrics?.totals.capacity ?? 0;
  const mByVmid = useMemo(() => new Map((metrics?.instances ?? []).map((r) => [r.vmid, r])), [metrics]);

  // All running game services (Minecraft + Hytale + …) for the presence strip.
  const gameServices = useMemo(() => {
    const out: { vmid: number; name: string; kind: string; online: boolean; players: number | null; max: number }[] = [];
    for (const g of state?.groups ?? [])
      for (const t of g.tasks ?? [])
        if (GAME_KINDS.has(t.softwareKind))
          for (const i of t.instances ?? [])
            if (i.status === "running") {
              const m = mByVmid.get(i.vmid);
              out.push({
                vmid: i.vmid, name: t.name, kind: t.softwareKind,
                online: QUERYABLE.has(t.softwareKind) ? !!m?.reachable : i.ready,
                players: QUERYABLE.has(t.softwareKind) ? (m?.online ?? 0) : null,
                max: m?.max ?? 0,
              });
            }
    return out;
  }, [state, mByVmid]);

  async function broadcast() {
    const c = cmd.trim();
    if (!c) return;
    setBusy(true);
    try {
      const ids = groupId === "__all" ? groups.map((g) => g.id) : [groupId];
      let sent = 0;
      for (const gid of ids) {
        const res = await fetch(`/api/groups/${gid}/broadcast`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: c }),
        });
        const j = await res.json();
        if (j.error) throw new Error(j.error);
        sent += j.sent ?? 0;
      }
      toast.success(`Sent to ${sent} server(s)`);
      setCmd("");
      setTimeout(refresh, 800);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function kick(p: PlayerRow) {
    setKicking(p.name);
    try {
      const res = await fetch(`/api/services/${p.vmid}/console`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: `kick ${p.name}` }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      toast.success(`Kicked ${p.name}`);
      setTimeout(refresh, 800);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setKicking(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Players"
        subtitle={`${total}/${capacity} online · ${gameServices.length} game service(s) running`}
        onRefresh={refresh}
        loading={loading}
      />

      {/* Game services presence strip (Minecraft + Hytale + …) */}
      {gameServices.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {gameServices.map((s) => (
            <a key={s.vmid} href={`/services/${s.vmid}`} className="panel flex items-center justify-between gap-2 p-3 transition-colors hover:border-white/15">
              <span className="flex min-w-0 items-center gap-2">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.online ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{s.name}</span>
                  <span className="block text-[10px] uppercase tracking-wider text-muted-foreground/70">{s.kind}</span>
                </span>
              </span>
              <span className="shrink-0 text-right text-xs tabular-nums">
                {s.players === null
                  ? <span className="text-muted-foreground/60">{s.online ? "online" : "—"}</span>
                  : <span className="text-emerald-400">{s.players}/{s.max}</span>}
              </span>
            </a>
          ))}
        </div>
      )}

      {/* Broadcast bar */}
      <div className="panel mb-4 p-3">
        <div className="mb-2 flex items-center gap-2"><Radio className="h-3.5 w-3.5 text-brand" /><span className="eyebrow">Broadcast command</span></div>
        <div className="flex items-center gap-2">
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}
            className="shrink-0 rounded-md border border-hairline bg-accent/30 px-2.5 py-2 text-[13px] outline-none">
            <option value="__all">All groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <input value={cmd} onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") broadcast(); }}
            placeholder='e.g. say Server restarting in 5 minutes'
            className="w-full rounded-md border border-hairline bg-accent/30 px-3 py-2 font-mono text-[13px] outline-none placeholder:text-muted-foreground/50" />
          <button onClick={broadcast} disabled={busy || !cmd.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send
          </button>
        </div>
      </div>

      {/* Player list */}
      <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline">
              {["Player", "Server", "Node #", ""].map((h, i) => (
                <th key={h || i} className={cn("px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground", i === 3 ? "text-right" : "text-left")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={`${p.vmid}-${p.name}`} className="group border-b border-hairline transition-colors last:border-0 hover:bg-accent/40">
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-[11px] font-semibold uppercase text-muted-foreground">{p.name.slice(0, 2)}</span>
                    <span className="font-medium">{p.name}</span>
                  </span>
                </td>
                <td className="px-4 py-2.5"><span className="flex items-center gap-2"><RoleDot role={p.role} /> {p.server}</span></td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">#{p.vmid}</td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => kick(p)} disabled={kicking === p.name}
                    className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1 text-xs text-muted-foreground opacity-0 transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 disabled:opacity-50">
                    {kicking === p.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserX className="h-3 w-3" />} Kick
                  </button>
                </td>
              </tr>
            ))}
            {players.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-16 text-center text-sm text-muted-foreground">
                <Users className="mx-auto mb-2 h-6 w-6 opacity-40" />
                No players online.
                {(metrics?.instances ?? []).every((r) => !r.reachable) && <div className="mt-1 text-xs text-muted-foreground/60">(no reachable MC servers)</div>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground/60">Player names come from Minecraft server-list-ping samples (capped at ~12 per server by the protocol).</p>
    </>
  );
}
