"use client";

/**
 * Player history (audit trail) — joins/quits/switches + panel actions for one player,
 * pulled from the DSGVO-retained audit store. Includes the right-to-erasure action.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  History, LogIn, LogOut, ArrowRightLeft, UserX, MoveRight, MessageSquare, Hourglass,
  Loader2, ShieldAlert, Trash2,
} from "lucide-react";

type AuditEntry = {
  at: number; type: "join" | "quit" | "switch" | "kick" | "move" | "message" | "unqueue";
  player: string; uuid?: string; server?: string; detail?: string; actor?: "player" | "panel";
};

const TYPE_META: Record<AuditEntry["type"], { icon: React.ElementType; color: string; label: (e: AuditEntry) => string }> = {
  join: { icon: LogIn, color: "#34d399", label: (e) => `joined ${e.server ?? "the network"}` },
  quit: { icon: LogOut, color: "#94a3b8", label: (e) => `left ${e.server ?? "the network"}` },
  switch: { icon: ArrowRightLeft, color: "#60a5fa", label: (e) => `switched to ${e.server ?? "?"}` },
  kick: { icon: UserX, color: "#f87171", label: (e) => `kicked by an operator${e.detail ? ` — "${e.detail}"` : ""}` },
  move: { icon: MoveRight, color: "#fbbf24", label: (e) => `moved to ${e.server ?? "?"} by an operator` },
  message: { icon: MessageSquare, color: "#c084fc", label: (e) => `operator message${e.detail ? `: "${e.detail}"` : ""}` },
  unqueue: { icon: Hourglass, color: "#94a3b8", label: () => "removed from a queue by an operator" },
};

export function PlayerHistoryDialog({ player, onClose }: { player: string; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setEntries(null);
    const r = await fetch(`/api/audit?player=${encodeURIComponent(player)}&days=${days}`)
      .then((x) => x.json()).catch(() => null);
    setEntries(r?.entries ?? []);
  }, [player, days]);
  useEffect(() => { load(); }, [load]);

  async function erase() {
    if (!confirm(`Permanently delete ALL stored history entries for "${player}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/audit/erase", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      toast.success(`Erased ${r.removed} entr${r.removed === 1 ? "y" : "ies"} for ${player}`);
      load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-brand" /> History · {player}
          </DialogTitle>
          <DialogDescription>
            Session + operator-action trail. Entries older than the retention window
            (configurable in Settings) are purged automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1">
          {[1, 7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)}
              className={cn("rounded px-2 py-1 text-[11px] font-medium transition-colors",
                days === d ? "bg-brand/15 text-brand" : "text-muted-foreground hover:text-foreground")}>
              {d}d
            </button>
          ))}
        </div>

        <div className="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
          {entries === null && <div className="py-8 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" /></div>}
          {entries?.length === 0 && (
            <p className="player-empty-in py-8 text-center text-sm text-muted-foreground">No entries in the last {days} day(s).</p>
          )}
          {entries?.map((e, i) => {
            const m = TYPE_META[e.type];
            const Icon = m.icon;
            return (
              <div key={`${e.at}-${i}`} className="player-row-in flex items-center gap-2.5 rounded-md border border-hairline px-3 py-2"
                style={{ animationDelay: `${Math.min(i * 14, 200)}ms` }}>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded" style={{ background: `color-mix(in oklch, ${m.color} 14%, transparent)` }}>
                  <Icon className="h-3.5 w-3.5" style={{ color: m.color }} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{m.label(e)}</span>
                {e.actor === "panel" && <ShieldAlert className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-label="operator action" />}
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {new Date(e.at).toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-hairline pt-3">
          <span className="text-[11px] text-muted-foreground">{entries?.length ?? 0} entr{(entries?.length ?? 0) === 1 ? "y" : "ies"}</span>
          <button onClick={erase} disabled={busy || !entries?.length}
            className="flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Erase player data
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
