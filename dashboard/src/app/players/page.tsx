"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { useStream } from "@/hooks/use-stream";
import { PageHeader } from "@/components/page-header";
import { RoleDot } from "@/components/role-dot";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { Users, Send, UserX, Radio, Loader2, MoveRight, MessageSquare, Gamepad2, Boxes } from "lucide-react";
import { MessageDialog, MoveDialog, KickDialog } from "@/components/player-action-dialogs";

type MetricRow = {
  vmid: number; taskName: string; role: string; reachable: boolean;
  online: number; max: number; sample: string[];
};
type Metrics = { instances: MetricRow[]; totals: { players: number; capacity: number } };
type StTask = { softwareKind: string; name: string; instances: { vmid: number; status: string; ready: boolean }[] };
type State = { groups: { id: string; name: string; tasks: StTask[] }[] };

type PlayerRow = { name: string; server: string; vmid: number; role: string; uuid?: string; group?: string; env?: string };
type DialogState = { kind: "move" | "message" | "kick"; player: PlayerRow } | null;

// Software kinds that represent a game/player service (vs db/web/generic).
const GAME_KINDS = new Set(["paper", "velocity", "hytale"]);
// Kinds we get live player counts for. Hytale now reports via its own connector.
const QUERYABLE = new Set(["paper", "velocity", "hytale"]);

type Conn = { active: boolean; players: { uuid: string; name: string; server?: string }[]; servers: { id: string; task: string; group: string; env: string }[] };

export default function PlayersPage() {
  const { data: metrics, loading, refresh } = usePoll<Metrics>("/api/metrics", 5000);
  const { data: state } = usePoll<State>("/api/conduit/state", 10000);
  // Live connector state via SSE (instant join/quit/kick/move), polling fallback.
  const { data: conn } = useStream<Conn>("/api/stream", "/api/connector/servers", 5000);
  const [cmd, setCmd] = useState("");
  const [groupId, setGroupId] = useState("__all");
  const [busy, setBusy] = useState(false);
  const [kicking, setKicking] = useState<string | null>(null);
  const [dlg, setDlg] = useState<DialogState>(null);
  // Optimistically hidden players (kick/move just issued) so the row disappears instantly;
  // re-confirmed by the next stream push (cleared when the player actually leaves the list).
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const connActive = !!conn?.active;

  // Prefer the connector's FULL player list (name+uuid, accurate per-server). Fall back to
  // backend SLP samples (capped ~12/server) when no connector is reporting.
  const players = useMemo<PlayerRow[]>(() => {
    if (connActive) {
      // Drive everything from the connector itself: task → vmid (trailing number of the server
      // id, e.g. network-hytale-203 → 203), task → group, and task → env ("hytale" vs "server").
      // Partitioning by env is reliable even if /api/conduit/state lags (which previously dumped
      // Hytale players into the MC table at vmid #0).
      const vmidByTask = new Map<string, number>();
      const groupByTask = new Map<string, string>();
      const envByTask = new Map<string, string>();
      for (const s of conn!.servers ?? []) {
        groupByTask.set(s.task, s.group);
        envByTask.set(s.task, s.env);
        const m = /-(\d+)$/.exec(s.id);
        if (m) vmidByTask.set(s.task, Number(m[1]));
      }
      // metrics vmid as a fallback when the connector id has no trailing number
      for (const r of metrics?.instances ?? []) if (!vmidByTask.has(r.taskName)) vmidByTask.set(r.taskName, r.vmid);
      return (conn!.players ?? []).map((p) => ({
        name: p.name, uuid: p.uuid, server: p.server ?? "?",
        vmid: vmidByTask.get(p.server ?? "") ?? 0, role: "smp",
        group: groupByTask.get(p.server ?? ""), env: envByTask.get(p.server ?? "") ?? "server",
      })).sort((a, b) => a.name.localeCompare(b.name));
    }
    const rows = (metrics?.instances ?? []).filter((r) => r.role !== "proxy" && r.reachable);
    const out: PlayerRow[] = [];
    for (const r of rows) for (const name of r.sample ?? []) out.push({ name, server: r.taskName, vmid: r.vmid, role: r.role });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [metrics, conn, connActive]);

  const groups = state?.groups ?? [];
  const total = metrics?.totals.players ?? 0;
  const capacity = metrics?.totals.capacity ?? 0;
  const mByVmid = useMemo(() => new Map((metrics?.instances ?? []).map((r) => [r.vmid, r])), [metrics]);

  // Drop optimistically-removed players (kick) until the stream confirms; for a move the player
  // reappears under the new server, so we only keep `removed` entries that are still present.
  const visible = useMemo(() => players.filter((p) => !removed.has(p.name.toLowerCase())), [players, removed]);
  useEffect(() => {
    if (removed.size === 0) return;
    const live = new Set(players.map((p) => `${p.name.toLowerCase()}|${p.server}`));
    setRemoved((prev) => {
      // keep a removal only while that exact name+server is still in the list (kick pending);
      // once it's gone (kicked) or changed server (moved), clear it.
      const next = new Set([...prev].filter((k) => [...live].some((l) => l.startsWith(k + "|"))));
      return next.size === prev.size ? prev : next;
    });
  }, [players, removed.size]);

  // Split by the connector's env ("hytale" vs MC) — reliable even if state lags.
  const hytalePlayers = useMemo(() => visible.filter((p) => p.env === "hytale"), [visible]);
  const mcPlayers = useMemo(() => visible.filter((p) => p.env !== "hytale"), [visible]);
  const hasHytale = useMemo(
    () => (conn?.servers ?? []).some((s) => s.env === "hytale")
      || (state?.groups ?? []).some((g) => (g.tasks ?? []).some((t) => t.softwareKind === "hytale")),
    [conn, state],
  );

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

  // Player actions: prefer the connector (network-wide via the proxy); fall back to console.
  async function playerAction(kind: "kick" | "move" | "message", p: PlayerRow, extra?: string) {
    setKicking(p.name);
    try {
      if (connActive) {
        const body: Record<string, string> = { kind, player: p.name };
        if (kind === "move") body.target = extra!;
        if (kind === "message") body.text = extra!;
        if (kind === "kick" && extra) body.reason = extra;
        const res = await fetch("/api/connector/action", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const j = await res.json();
        if (j.error) throw new Error(j.error);
      } else if (kind === "kick") {
        // SLP fallback: kick via the backend console
        const res = await fetch(`/api/services/${p.vmid}/console`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: `kick ${p.name}` }),
        });
        const j = await res.json();
        if (j.error) throw new Error(j.error);
      } else {
        throw new Error("connector required for that action");
      }
      toast.success(`${kind} → ${p.name}`);
      // Optimistic: hide the row immediately (kick → gone; move → reappears under the new
      // server). The SSE stream confirms within ~0.5s and clears the optimistic state.
      if (kind === "kick" || kind === "move") setRemoved((s) => new Set(s).add(p.name.toLowerCase()));
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
        subtitle={`${connActive ? visible.length : total}/${capacity} online · ${gameServices.length} game service(s)${connActive ? " · live" : " · SLP (sample)"}`}
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

      {/* Minecraft players */}
      <PlayerTable
        icon={<Gamepad2 className="h-3.5 w-3.5 text-brand" />}
        label="Minecraft players"
        count={mcPlayers.length}
        players={mcPlayers}
        kicking={kicking}
        connActive={connActive}
        onOpenDialog={(kind, p) => setDlg({ kind, player: p })}
        emptyHint={(metrics?.instances ?? []).every((r) => !r.reachable) ? "(no reachable Minecraft servers)" : undefined}
      />

      {/* Hytale players — shown whenever a Hytale service exists (mirrors the MC section) */}
      {hasHytale && (
        <div className="mt-5">
          <PlayerTable
            icon={<Boxes className="h-3.5 w-3.5 text-violet-400" />}
            label="Hytale players"
            count={hytalePlayers.length}
            players={hytalePlayers}
            kicking={kicking}
            connActive={connActive}
            onOpenDialog={(kind, p) => setDlg({ kind, player: p })}
            emptyHint="(Hytale connector reports players here once they join)"
          />
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground/60">{connActive ? "Live player lists via the Conduit connector — right-click a player for move/message/kick · in-game: /ct." : "Player names from Minecraft server-list-ping samples (capped at ~12 per server)."}</p>

      {/* player-action dialogs (styled message, compatible-service move picker, kick) */}
      {dlg?.kind === "message" && (
        <MessageDialog open onOpenChange={(o) => !o && setDlg(null)} target={dlg.player.name}
          platform={dlg.player.env === "hytale" ? "hytale" : "minecraft"}
          onSend={(text) => playerAction("message", dlg.player, text)} />
      )}
      {dlg?.kind === "move" && (
        <MoveDialog open onOpenChange={(o) => !o && setDlg(null)} player={dlg.player}
          kindLabel={dlg.player.env === "hytale" ? "Hytale" : "Minecraft"}
          onMove={(target) => playerAction("move", dlg.player, target)} />
      )}
      {dlg?.kind === "kick" && (
        <KickDialog open onOpenChange={(o) => !o && setDlg(null)} target={dlg.player.name}
          onKick={(reason) => playerAction("kick", dlg.player, reason || undefined)} />
      )}
    </>
  );
}

/** Minecraft skin head (mc-heads.net, by UUID when known else name). Hytale has no MC skin —
 *  show initials. Falls back to initials if the avatar fails to load. */
function PlayerHead({ player }: { player: PlayerRow }) {
  const [failed, setFailed] = useState(false);
  const initials = (
    <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-[11px] font-semibold uppercase text-muted-foreground">{player.name.slice(0, 2)}</span>
  );
  if (player.env === "hytale" || failed) return initials;
  // The network runs offline-mode, so the reported UUID is an offline/v3 UUID (name-derived) that
  // skin services can't resolve → Steve. A real premium UUID is v4 (the 15th hex digit is "4").
  // Use the UUID only when it's premium; otherwise look up by name (mc-heads resolves the skin
  // from the Mojang username).
  const uuidPremium = !!player.uuid && player.uuid.replace(/-/g, "")[12] === "4";
  const key = uuidPremium ? player.uuid! : player.name;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`https://mc-heads.net/avatar/${encodeURIComponent(key)}/24`} alt={player.name}
      width={24} height={24} className="h-6 w-6 rounded" onError={() => setFailed(true)} />
  );
}

function PlayerTable({
  icon, label, count, players, kicking, connActive, onOpenDialog, emptyHint,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  players: PlayerRow[];
  kicking: string | null;
  connActive: boolean;
  onOpenDialog: (kind: "kick" | "move" | "message", p: PlayerRow) => void;
  emptyHint?: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 px-0.5">
        {icon}
        <span className="eyebrow">{label}</span>
        <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{count}</span>
      </div>
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
              <ContextMenu key={`${p.vmid}-${p.name}`}>
                <ContextMenuTrigger render={<tr className="group cursor-default border-b border-hairline transition-colors last:border-0 hover:bg-accent/40" />}>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <PlayerHead player={p} />
                      <span className="font-medium">{p.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5"><span className="flex items-center gap-2"><RoleDot role={p.role} /> {p.server}</span></td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">#{p.vmid}</td>
                  <td className="px-4 py-2.5 text-right">
                    {kicking === p.name
                      ? <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      : <span className="text-[11px] text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100">right-click ⋯</span>}
                  </td>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuLabel>{p.name}{p.uuid ? ` · ${p.uuid.slice(0, 8)}` : ""}</ContextMenuLabel>
                  <ContextMenuItem disabled={!connActive} onClick={() => onOpenDialog("move", p)}><MoveRight /> Move to…</ContextMenuItem>
                  <ContextMenuItem disabled={!connActive} onClick={() => onOpenDialog("message", p)}><MessageSquare /> Message…</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={!connActive} variant="destructive" onClick={() => onOpenDialog("kick", p)}><UserX /> Kick</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
            {players.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-12 text-center text-sm text-muted-foreground">
                <Users className="mx-auto mb-2 h-6 w-6 opacity-40" />
                No players online.
                {emptyHint && <div className="mt-1 text-xs text-muted-foreground/60">{emptyHint}</div>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
