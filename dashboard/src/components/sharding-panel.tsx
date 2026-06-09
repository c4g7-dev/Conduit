"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Globe2, Loader2, Map as MapIcon, Info, Plus, TriangleAlert, Dices } from "lucide-react";
import { HelpButton } from "@/components/help-center";

type Strip = { min: number; max: number };
type Region = {
  serverId: string; target: string; name: string; index: number; vmid: number;
  worlds: { world: Strip; world_nether: Strip; world_the_end?: Strip };
  online: number; max: number; reachable: boolean;
};
type Grid = {
  world: string; tol: number; splitEnd: boolean; cancelRange: number;
  center: { x: number; z: number };
  border: { world: number; world_nether: number; world_the_end?: number };
  regions: Region[];
};
type Sharding = { enabled: boolean; world: string; stripWidth: number; splitEnd: boolean; borderCancelRange: number };
type Resp = { sharding: Sharding | null; grid: Grid | null };

const BAND = ["#38bdf8", "#34d399", "#fb923c", "#a78bfa", "#f472b6", "#facc15", "#22d3ee", "#f87171"];
const fmt = (n: number) => Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`;

export function ShardingPanel({ taskId, instanceCount, taskMax }: { taskId: string; instanceCount: number; taskMax: number }) {
  const { data, refresh } = usePoll<Resp>(`/api/tasks/${taskId}/sharding`, 5000);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [enableOpen, setEnableOpen] = useState(false);
  // local editable draft (seeded from server, only while not focused-saving)
  const cfg = data?.sharding ?? { enabled: false, world: "world", stripWidth: 5000, splitEnd: true, borderCancelRange: 30 };
  const [draft, setDraft] = useState<Sharding | null>(null);
  const s = draft ?? cfg;

  // capped when max>0 and we've reached it (raise the task's max to add more regions).
  const atCap = taskMax > 0 && (data?.grid?.regions.length ?? instanceCount) >= taskMax;

  // "+" on the region map: add another region. Strips re-tile (auto east/west by instance order),
  // so we bump desired by one (raising max if needed so the clamp doesn't swallow it).
  async function addRegion() {
    setAdding(true);
    try {
      const have = data?.grid?.regions.length ?? instanceCount;
      const body: Record<string, number> = { delta: 1 };
      if (taskMax > 0 && have + 1 > taskMax) body.max = have + 1;
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      toast.success("Adding a region — it'll join the world once provisioned");
      setTimeout(refresh, 600);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function save(next: Partial<Sharding>) {
    const merged = { ...s, ...next };
    setDraft(merged);
    setSaving(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sharding: merged }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setTimeout(() => { setDraft(null); refresh(); }, 400);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="mb-1 flex items-center gap-2">
          <Globe2 className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold">Seamless world (sharding)</h3>
          <HelpButton topic="sharding-enable" />
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Split one world across this task&apos;s instances along the X axis — each instance owns a vertical
          strip and players are handed off seamlessly (keeping their exact position) when they cross a
          boundary. Same seed everywhere ⇒ one continuous world. Inspired by TMregion.
        </p>

        {/* enable toggle */}
        <label className="flex cursor-pointer items-center justify-between rounded-md border border-hairline bg-accent/30 px-3 py-2.5">
          <span className="text-[13px] font-medium">Enable sharding</span>
          <button
            type="button" role="switch" aria-checked={s.enabled}
            onClick={() => { if (s.enabled) save({ enabled: false }); else setEnableOpen(true); }}
            className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", s.enabled ? "bg-brand" : "bg-muted-foreground/30")}
          >
            <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform", s.enabled ? "translate-x-[18px]" : "translate-x-0.5")} />
          </button>
        </label>

        {s.enabled && (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="World" hint="overworld name">
              <input value={s.world} onChange={(e) => setDraft({ ...s, world: e.target.value })} onBlur={(e) => save({ world: e.target.value })}
                className="w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-[13px] outline-none" />
            </Field>
            {/* Region width in overworld CHUNKS (the intuitive MC unit). 1 chunk = 16 blocks;
                the overworld strip is stripWidth×8 blocks, so chunks = stripWidth/2 and
                stripWidth = chunks×2. The nether strip is chunks/8 (MC's 1:8 scale). */}
            <Field label="Chunks / region" help="shard-chunks" hint={`${(s.stripWidth * 8).toLocaleString()} blocks overworld`}>
              <input type="number" min={16} step={16} value={Math.round(s.stripWidth / 2)}
                onChange={(e) => setDraft({ ...s, stripWidth: Math.max(2, Number(e.target.value) * 2) })}
                onBlur={(e) => save({ stripWidth: Math.max(2, Number(e.target.value) * 2) })}
                className="w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-[13px] tabular-nums outline-none" />
            </Field>
            <Field label="Seam buffer" help="shard-seam" hint="no-build blocks at edge">
              <input type="number" min={0} step={5} value={s.borderCancelRange}
                onChange={(e) => setDraft({ ...s, borderCancelRange: Number(e.target.value) })} onBlur={(e) => save({ borderCancelRange: Number(e.target.value) })}
                className="w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-[13px] tabular-nums outline-none" />
            </Field>
            <Field label="Split End" help="shard-splitend" hint="shard the End too">
              <button onClick={() => save({ splitEnd: !s.splitEnd })}
                className={cn("w-full rounded-md border px-2.5 py-1.5 text-[13px] font-medium transition-colors", s.splitEnd ? "border-brand/40 bg-brand/10 text-brand" : "border-hairline text-muted-foreground")}>
                {s.splitEnd ? "On" : "Off"}
              </button>
            </Field>
          </div>
        )}
      </div>

      {/* region grid visualization — always shown (live preview even when disabled) so you can
          see how the world would shard before flipping the toggle. */}
      <div className="panel overflow-hidden">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
          <MapIcon className="h-3.5 w-3.5 text-brand" />
          <div className="eyebrow">Region map · overworld</div>
          {!s.enabled && <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">preview · sharding off</span>}
          <div className="ml-auto text-[11px] text-muted-foreground/70">X axis →</div>
        </div>
        <div className="p-4">
          {!data?.grid || data.grid.regions.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Info className="mx-auto mb-2 h-5 w-5 opacity-40" />
              {instanceCount < 1
                ? "No instances yet — scale this task up to form regions."
                : "Waiting for instances to report (connector)…"}
            </div>
          ) : (
            <>
              {!s.enabled && (
                <p className="mb-3 text-[12px] text-muted-foreground">
                  This is how the world would split across the current instances. Enable sharding above to make it live.
                </p>
              )}
              <RegionMap grid={data.grid} addRegion={addRegion} adding={adding} atCap={atCap} />
            </>
          )}
        </div>
      </div>

      <EnableShardingDialog
        open={enableOpen}
        onOpenChange={setEnableOpen}
        instanceCount={data?.grid?.regions.length ?? instanceCount}
        onConfirm={async (seed) => {
          const res = await fetch(`/api/tasks/${taskId}/sharding`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seed }),
          });
          const j = await res.json();
          if (j.error) throw new Error(j.error);
          toast.success(`Sharding enabled — seed ${j.seed}, ${j.regenerated} server(s) regenerating`);
          setTimeout(refresh, 1500);
        }}
      />
    </div>
  );
}

/** Enabling sharding regenerates every region's world on a shared seed — gate it behind an
 *  explicit warning + a seed choice (manual or auto). */
function EnableShardingDialog({ open, onOpenChange, instanceCount, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; instanceCount: number;
  onConfirm: (seed: string) => Promise<void>;
}) {
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setSeed(""); }, [open]);
  async function go() {
    setBusy(true);
    try { await onConfirm(seed.trim()); onOpenChange(false); }
    catch (e) { toast.error(String(e)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><TriangleAlert className="h-4 w-4 text-amber-400" /> Enable seamless world</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
            All <span className="font-semibold">{instanceCount}</span> server(s) in this task will be <span className="font-semibold">rebooted</span> and their worlds <span className="font-semibold">regenerated</span> on one shared seed so the terrain is continuous across shards. Current world data on these instances is lost. This is not meant for already-populated persistent worlds.
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Shared seed</label>
            <div className="flex gap-2">
              <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="leave blank to auto-generate"
                className="w-full rounded-md border border-hairline bg-accent/30 px-3 py-2 font-mono text-[13px] outline-none placeholder:text-muted-foreground/40" />
              <button type="button" title="Random seed" onClick={() => setSeed(String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000))}
                className="flex shrink-0 items-center justify-center rounded-md border border-hairline px-2.5 hover:bg-accent">
                <Dices className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="rounded-md px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground">Cancel</button>
            <button onClick={go} disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-amber-600 px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe2 className="h-3.5 w-3.5" />} Enable & regenerate
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, help, children }: { label: string; hint?: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}{help && <HelpButton topic={help} />}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-[10px] text-muted-foreground/60">{hint}</span>}
    </label>
  );
}

/** Top-down strip map: the overworld border span split into per-instance colored bands. */
function RegionMap({ grid, addRegion, adding, atCap }: { grid: Grid; addRegion?: () => void; adding: boolean; atCap: boolean }) {
  const centerWorld = grid.center.x * 8;
  const half = grid.border.world / 2;
  const left = centerWorld - half;
  const right = centerWorld + half;
  const span = right - left || 1;

  const bands = useMemo(() => {
    return grid.regions
      .map((r, i) => {
        const lo = Math.max(left, r.worlds.world.min);
        const hi = Math.min(right, r.worlds.world.max);
        return { r, i, lo, hi, pct: ((lo - left) / span) * 100, w: ((hi - lo) / span) * 100 };
      })
      .filter((b) => b.w > 0)
      .sort((a, b) => a.lo - b.lo);
  }, [grid, left, right, span]);

  const totalOnline = grid.regions.reduce((n, r) => n + r.online, 0);

  // Interior boundaries between adjacent strips (the X handed off to the neighbour). Each is a
  // labelled marker + an add-region affordance. Outer edges get a "+" too.
  const boundaries = bands.slice(1).map((b) => ({ x: b.lo, pct: ((b.lo - left) / span) * 100 }));

  return (
    <div>
      {/* the band */}
      <div className="relative h-28 w-full overflow-visible rounded-lg border border-hairline bg-[#0a0c10]">
        <div className="absolute inset-0 overflow-hidden rounded-lg">
          {bands.map((b) => (
            <div key={b.r.serverId} className="absolute top-0 flex h-full flex-col items-center justify-center overflow-hidden border-r border-black/40 text-center"
              style={{ left: `${b.pct}%`, width: `${b.w}%`, background: `${BAND[b.i % BAND.length]}22` }}>
              <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: BAND[b.i % BAND.length] }} />
              <span className="truncate px-1 text-[11px] font-semibold" style={{ color: BAND[b.i % BAND.length] }}>{b.r.name.replace(/^network-/, "")}</span>
              <span className="text-[10px] tabular-nums text-slate-300">{fmt(b.lo)} … {fmt(b.hi)}</span>
              <span className="mt-0.5 flex items-center gap-1 text-[10px] tabular-nums">
                <span className={cn("h-1.5 w-1.5 rounded-full", b.r.reachable ? "bg-emerald-400" : "bg-slate-600")} />
                <span className="text-emerald-300">{b.r.online}</span><span className="text-slate-500">/{b.r.max}</span>
              </span>
            </div>
          ))}
          {/* center line */}
          <div className="absolute top-0 h-full w-px bg-white/30" style={{ left: `${((centerWorld - left) / span) * 100}%` }} />
        </div>

        {/* boundary X coordinate labels (the handoff seam between regions) */}
        {boundaries.map((bd, i) => (
          <div key={i} className="pointer-events-none absolute -top-px z-10" style={{ left: `${bd.pct}%`, transform: "translateX(-50%)" }}>
            <span className="rounded-b bg-white/10 px-1 text-[9px] tabular-nums text-slate-200">x {fmt(bd.x)}</span>
          </div>
        ))}

        {/* "+" add-region affordances: each strip boundary + the two outer edges. Adding a
            region re-tiles the strips (they auto-arrange east/west by instance order). */}
        {addRegion && [
          { key: "edgeL", pct: 0, tip: "Add region (west edge)" },
          ...boundaries.map((bd, i) => ({ key: `b${i}`, pct: bd.pct, tip: `Add region at x ${fmt(bd.x)}` })),
          { key: "edgeR", pct: 100, tip: "Add region (east edge)" },
        ].map((m) => (
          <button key={m.key} title={m.tip} disabled={atCap || adding} onClick={addRegion}
            className="absolute bottom-0 z-20 flex h-5 w-5 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-panel text-brand shadow transition-colors hover:bg-brand hover:text-brand-foreground disabled:cursor-not-allowed disabled:opacity-30"
            style={{ left: `${m.pct}%` }}>
            {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </button>
        ))}
      </div>
      {/* ruler — the left/right edges are a hard vanilla world border (no server beyond) */}
      <div className="mt-2 flex justify-between text-[10px] tabular-nums text-muted-foreground/60">
        <span title="hard world border — players can't pass">⊣ {fmt(left)}</span>
        <span>center {fmt(centerWorld)}</span>
        <span title="hard world border — players can't pass">{fmt(right)} ⊢</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span><span className="font-medium text-foreground">{grid.regions.length}</span> regions</span>
        <span>border <span className="font-medium tabular-nums text-foreground">{fmt(grid.border.world)}</span> blocks</span>
        <span>strip <span className="font-medium tabular-nums text-foreground">{fmt(grid.tol * 8)}</span> (overworld)</span>
        <span><span className="font-medium tabular-nums text-foreground">{totalOnline}</span> online</span>
        {grid.splitEnd && <span className="text-muted-foreground/70">End sharded</span>}
        {atCap && <span className="text-amber-400/80">at max — raise the task max to add more</span>}
      </div>
    </div>
  );
}
