"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { useStream } from "@/hooks/use-stream";
import { PageHeader } from "@/components/page-header";
import { RoleDot } from "@/components/role-dot";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { Users, UserX, Loader2, MoveRight, MessageSquare, Gamepad2, Boxes, History } from "lucide-react";
import { MessageDialog, MoveDialog, KickDialog } from "@/components/player-action-dialogs";
import { PlayerHistoryDialog } from "@/components/player-history-dialog";

type MetricRow = {
  vmid: number; taskName: string; role: string; reachable: boolean;
  online: number; max: number; sample: string[];
};
type Metrics = { instances: MetricRow[]; totals: { players: number; capacity: number } };
type StTask = { softwareKind: string; name: string; instances: { vmid: number; status: string; ready: boolean }[] };
type State = { groups: { id: string; name: string; tasks: StTask[] }[] };

type PlayerRow = { name: string; server: string; vmid: number; role: string; uuid?: string; group?: string; env?: string; serverId?: string };
type DialogState = { kind: "move" | "message" | "kick"; player: PlayerRow } | null;

// Software kinds that represent a game/player service (vs db/web/generic).
const GAME_KINDS = new Set(["paper", "velocity", "hytale"]);
// Kinds we get live player counts for. Hytale now reports via its own connector.
const QUERYABLE = new Set(["paper", "velocity", "hytale"]);

type Conn = { active: boolean; players: { uuid: string; name: string; server?: string; serverId?: string }[]; servers: { id: string; task: string; group: string; env: string }[] };

export default function PlayersPage() {
  const { data: metrics, loading, refresh } = usePoll<Metrics>("/api/metrics", 5000);
  const { data: state } = usePoll<State>("/api/conduit/state", 10000);
  // Live connector state via SSE (instant join/quit/kick/move), polling fallback.
  const { data: conn } = useStream<Conn>("/api/stream", "/api/connector/servers", 5000);
  const [kicking, setKicking] = useState<string | null>(null);
  const [dlg, setDlg] = useState<DialogState>(null);
  // audit-trail dialog (any player, online or not)
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
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
      // Index connector servers by their per-INSTANCE id (e.g. network-world-204), so a player
      // resolves to the exact instance they're on — not just any instance sharing the task name
      // (which made a scaled task always map to one vmid). Fall back to task-name when a player
      // record lacks a serverId.
      const byId = new Map<string, { task: string; group: string; env: string; vmid: number }>();
      const byTask = new Map<string, { group: string; env: string; vmid: number }>();
      for (const s of conn!.servers ?? []) {
        const m = /-(\d+)$/.exec(s.id);
        const vmid = m ? Number(m[1]) : 0;
        byId.set(s.id, { task: s.task, group: s.group, env: s.env, vmid });
        if (!byTask.has(s.task)) byTask.set(s.task, { group: s.group, env: s.env, vmid });
      }
      return (conn!.players ?? []).map((p) => {
        const inst = (p.serverId && byId.get(p.serverId)) || byTask.get(p.server ?? "");
        return {
          name: p.name, uuid: p.uuid, server: p.server ?? "?", role: "smp",
          vmid: inst?.vmid ?? 0,
          group: inst?.group,
          env: inst?.env ?? "server",
          serverId: p.serverId,
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
    }
    const rows = (metrics?.instances ?? []).filter((r) => r.role !== "proxy" && r.reachable);
    const out: PlayerRow[] = [];
    for (const r of rows) for (const name of r.sample ?? []) out.push({ name, server: r.taskName, vmid: r.vmid, role: r.role });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [metrics, conn, connActive]);


  const total = metrics?.totals.players ?? 0;
  const capacity = metrics?.totals.capacity ?? 0;
  const mByVmid = useMemo(() => new Map((metrics?.instances ?? []).map((r) => [r.vmid, r])), [metrics]);

  // Optimistic-removal key is name+serverId, so kicking MC c4g7 only hides THAT row, not a
  // same-named Hytale player. Drop the hidden row until the stream confirms (kick → gone; move →
  // reappears under the new serverId, which is a different key so it shows again).
  const visible = useMemo(() => players.filter((p) => !removed.has(`${p.name.toLowerCase()}|${p.serverId ?? ""}`)), [players, removed]);
  useEffect(() => {
    if (removed.size === 0) return;
    const live = new Set(players.map((p) => `${p.name.toLowerCase()}|${p.serverId ?? ""}`));
    setRemoved((prev) => {
      const next = new Set([...prev].filter((k) => live.has(k))); // still present → keep hiding
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

  // Running game services grouped by task — so a scaled-up task (e.g. two `world` servers) is
  // ONE card listing its instances (vmid + player count), not N separate cards.
  type Inst = { vmid: number; online: boolean; players: number | null; max: number };
  type SvcGroup = { name: string; kind: string; queryable: boolean; instances: Inst[]; players: number | null; max: number; anyOnline: boolean };
  const gameServices = useMemo<SvcGroup[]>(() => {
    const groups: SvcGroup[] = [];
    for (const g of state?.groups ?? [])
      for (const t of g.tasks ?? []) {
        if (!GAME_KINDS.has(t.softwareKind)) continue;
        const queryable = QUERYABLE.has(t.softwareKind);
        const instances: Inst[] = [];
        for (const i of t.instances ?? []) {
          if (i.status !== "running") continue;
          const m = mByVmid.get(i.vmid);
          instances.push({
            vmid: i.vmid,
            online: queryable ? !!m?.reachable : i.ready,
            players: queryable ? (m?.online ?? 0) : null,
            max: m?.max ?? 0,
          });
        }
        if (instances.length === 0) continue;
        instances.sort((a, b) => a.vmid - b.vmid);
        groups.push({
          name: t.name, kind: t.softwareKind, queryable, instances,
          players: queryable ? instances.reduce((n, i) => n + (i.players ?? 0), 0) : null,
          max: instances.reduce((n, i) => n + i.max, 0),
          anyOnline: instances.some((i) => i.online),
        });
      }
    return groups;
  }, [state, mByVmid]);
  const totalGameInstances = useMemo(() => gameServices.reduce((n, g) => n + g.instances.length, 0), [gameServices]);

  // Player actions: prefer the connector (network-wide via the proxy); fall back to console.
  async function playerAction(kind: "kick" | "move" | "message", p: PlayerRow, extra?: string) {
    setKicking(`${p.name.toLowerCase()}|${p.serverId ?? ""}`);
    try {
      if (connActive) {
        const body: Record<string, string> = { kind, player: p.name };
        // Scope to the player's current server so a same-name player on another platform
        // (e.g. Hytale vs MC c4g7) isn't also hit.
        if (p.serverId) body.serverId = p.serverId;
        if (p.env) body.env = p.env;
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
      if (kind === "kick" || kind === "move") setRemoved((s) => new Set(s).add(`${p.name.toLowerCase()}|${p.serverId ?? ""}`));
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
        subtitle={`${connActive ? visible.length : total}/${capacity} online · ${totalGameInstances} instance(s) across ${gameServices.length} service(s)${connActive ? " · live" : " · SLP (sample)"}`}
        onRefresh={refresh}
        loading={loading}
      >
        {/* audit lookup — works for OFFLINE players too (queries the stored trail) */}
        <form
          onSubmit={(e) => { e.preventDefault(); if (historyQuery.trim()) setHistoryFor(historyQuery.trim()); }}
          className="flex items-center gap-1.5 rounded-md border border-hairline bg-accent/30 px-2 py-1.5"
        >
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
            placeholder="Player history…"
            className="w-32 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </form>
      </PageHeader>

      {/* Game services presence strip — one card per server task; scaled tasks list their
          instances (vmid + count) inside, with an aggregate header. */}
      {gameServices.length > 0 && (
        <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {gameServices.map((s) => {
            const scaled = s.instances.length > 1;
            return (
              <div key={s.name} className="panel overflow-hidden p-0 transition-colors hover:border-white/15">
                {/* header — task name, kind, aggregate count + instance badge */}
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn("relative flex h-2 w-2 shrink-0", s.anyOnline ? "" : "opacity-40")}>
                      {s.anyOnline && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
                      <span className={cn("relative inline-flex h-2 w-2 rounded-full", s.anyOnline ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold">{s.name}</span>
                        {scaled && <span className="rounded-full bg-accent px-1.5 py-px text-[9px] font-semibold tabular-nums text-muted-foreground">×{s.instances.length}</span>}
                      </span>
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground/60">{s.kind}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-[13px] font-semibold tabular-nums">
                    {s.players === null
                      ? <span className="text-muted-foreground/60">{s.anyOnline ? "online" : "—"}</span>
                      : <span className="text-emerald-400">{s.players}<span className="text-muted-foreground/50">/{s.max}</span></span>}
                  </span>
                </div>
                {/* instances — vmid chips with per-instance counts (always shown so the ids are visible) */}
                <div className="flex flex-wrap gap-1.5 border-t border-hairline bg-black/20 px-3 py-2">
                  {s.instances.map((i) => (
                    <a key={i.vmid} href={`/services/${i.vmid}`} title={`Open #${i.vmid}`}
                      className="group flex items-center gap-1.5 rounded-md border border-hairline bg-panel px-2 py-1 transition-colors hover:border-white/20 hover:bg-accent/50">
                      <span className={cn("h-1.5 w-1.5 rounded-full", i.online ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                      <span className="font-mono text-[11px] text-muted-foreground group-hover:text-foreground">#{i.vmid}</span>
                      {i.players === null
                        ? <span className="text-[11px] text-muted-foreground/50">{i.online ? "up" : "—"}</span>
                        : <span className="text-[11px] tabular-nums text-emerald-400/90">{i.players}/{i.max}</span>}
                    </a>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Minecraft players */}
      <PlayerTable
        icon={<Gamepad2 className="h-3.5 w-3.5 text-brand" />}
        label="Minecraft players"
        count={mcPlayers.length}
        players={mcPlayers}
        kicking={kicking}
        connActive={connActive}
        onOpenDialog={(kind, p) => setDlg({ kind, player: p })}
        onHistory={setHistoryFor}
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
            onHistory={setHistoryFor}
          />
        </div>
      )}

      {historyFor && <PlayerHistoryDialog player={historyFor} onClose={() => setHistoryFor(null)} />}

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

const rowKey = (p: PlayerRow) => `${p.vmid}-${p.name.toLowerCase()}-${p.serverId ?? ""}`;

/** Keep just-removed rows rendered briefly with an exit class so leaving players animate out
 *  instead of vanishing; new players get marked fresh so they animate in. */
function useAnimatedRows(players: PlayerRow[]) {
  const [rows, setRows] = useState<(PlayerRow & { _exiting?: boolean })[]>(players);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const incoming = new Map(players.map((p) => [rowKey(p), p]));
    setRows((prev) => {
      const merged: (PlayerRow & { _exiting?: boolean })[] = players.map((p) => ({ ...p }));
      // any previously-shown row no longer present → keep as an exiting ghost for the animation
      for (const r of prev) {
        const k = rowKey(r);
        if (!incoming.has(k) && !r._exiting) {
          merged.push({ ...r, _exiting: true });
          if (!timers.current.has(k)) {
            timers.current.set(k, setTimeout(() => {
              timers.current.delete(k);
              setRows((cur) => cur.filter((x) => rowKey(x) !== k));
            }, 230));
          }
        } else if (!incoming.has(k) && r._exiting) {
          merged.push(r); // still animating out
        }
      }
      return merged;
    });
  }, [players]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  return rows;
}

function PlayerTable({
  icon, label, count, players, kicking, connActive, onOpenDialog, onHistory, emptyHint,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  players: PlayerRow[];
  kicking: string | null;
  connActive: boolean;
  onOpenDialog: (kind: "kick" | "move" | "message", p: PlayerRow) => void;
  onHistory: (name: string) => void;
  emptyHint?: string;
}) {
  const rows = useAnimatedRows(players);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 px-0.5">
        {icon}
        <span className="eyebrow">{label}</span>
        <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{count}</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-hairline bg-panel">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-hairline">
              {["Player", "Server", "Node #", ""].map((h, i) => (
                <th key={h || i} className={cn("px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground", i === 3 ? "text-right" : "text-left")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <ContextMenu key={rowKey(p)}>
                <ContextMenuTrigger render={<tr className={cn("group cursor-default border-b border-hairline transition-colors last:border-0 hover:bg-accent/40", p._exiting ? "player-row-out" : "player-row-in")} />}>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <PlayerHead player={p} />
                      <span className="font-medium">{p.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5"><span className="flex items-center gap-2"><RoleDot role={p.role} /> {p.server}</span></td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">#{p.vmid}</td>
                  <td className="px-4 py-2.5 text-right">
                    {kicking === `${p.name.toLowerCase()}|${p.serverId ?? ""}`
                      ? <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      : <span className="text-[11px] text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100">right-click ⋯</span>}
                  </td>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuLabel>{p.name}{p.uuid ? ` · ${p.uuid.slice(0, 8)}` : ""}</ContextMenuLabel>
                  <ContextMenuItem disabled={!connActive} onClick={() => onOpenDialog("move", p)}><MoveRight /> Move to…</ContextMenuItem>
                  <ContextMenuItem disabled={!connActive} onClick={() => onOpenDialog("message", p)}><MessageSquare /> Message…</ContextMenuItem>
                  <ContextMenuItem onClick={() => onHistory(p.name)}><History /> History…</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={!connActive} variant="destructive" onClick={() => onOpenDialog("kick", p)}><UserX /> Kick</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-12 text-center text-sm text-muted-foreground">
                <div className="player-empty-in">
                  <Users className="mx-auto mb-2 h-6 w-6 opacity-40" />
                  No players online.
                  {emptyHint && <div className="mt-1 text-xs text-muted-foreground/60">{emptyHint}</div>}
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
