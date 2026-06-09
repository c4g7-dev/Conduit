"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Infinity as InfinityIcon, Pin } from "lucide-react";

export type EditableTask = {
  id: string; name: string; mode: "dynamic" | "static"; persistent: boolean;
  min: number; max: number; playersPerInstance: number;
  scaleUpPercent?: number; scaleDownAfterSec?: number; preparedPool?: number;
  cores: number; memory: number; disk: number;
};

function Num({ label, value, onChange, min = 0, suffix, hint }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; suffix?: string; hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex items-center rounded-md border border-hairline bg-accent/30 px-2.5 focus-within:border-brand/50">
        <input type="number" min={min} value={value} onChange={(e) => onChange(Number(e.target.value))}
          className="w-full bg-transparent py-2 text-sm outline-none" />
        {suffix && <span className="pl-1 text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {hint && <span className="mt-1 block text-[10px] text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

/**
 * Edit a service's scaling settings + convert static↔dynamic. Converting a PERSISTENT service
 * to dynamic is blocked (its instances own unique world data — dynamic would duplicate/reset
 * it). Routing note: changing a service that a proxy fronts is picked up by every proxy on the
 * next reconcile (the controller pushes the same config to all proxy instances).
 */
export function TaskSettingsDialog({ task, open, onOpenChange, onSaved }: {
  task: EditableTask; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const [mode, setMode] = useState(task.mode);
  const [min, setMin] = useState(task.min);
  const [max, setMax] = useState(task.max);
  const [pps, setPps] = useState(task.playersPerInstance);
  const [scaleUpPercent, setScaleUpPercent] = useState(task.scaleUpPercent ?? 100);
  const [scaleDownAfterSec, setScaleDownAfterSec] = useState(task.scaleDownAfterSec ?? 60);
  const [preparedPool, setPreparedPool] = useState(task.preparedPool ?? 0);
  const [cores, setCores] = useState(task.cores);
  const [memory, setMemory] = useState(task.memory);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setMode(task.mode); setMin(task.min); setMax(task.max); setPps(task.playersPerInstance);
      setScaleUpPercent(task.scaleUpPercent ?? 100); setScaleDownAfterSec(task.scaleDownAfterSec ?? 60);
      setPreparedPool(task.preparedPool ?? 0); setCores(task.cores); setMemory(task.memory);
    }
  }, [open, task]);

  // A persistent service can't become dynamic (it owns unique data).
  const canBeDynamic = !task.persistent;

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        mode, autoscale: mode === "dynamic", min, max, playersPerInstance: pps, cores, memory,
      };
      if (mode === "dynamic") {
        body.scaleUpPercent = scaleUpPercent;
        body.scaleDownAfterSec = scaleDownAfterSec;
        body.preparedPool = preparedPool;
      }
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      toast.success(`${task.name} updated`);
      onOpenChange(false);
      onSaved();
    } catch (e) { toast.error(String(e)); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{task.name} · settings</DialogTitle>
          <DialogDescription>Scaling mode and resources. Changes apply on the next reconcile (~10s).</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Mode toggle */}
          <div>
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Mode</span>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setMode("static")}
                className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  mode === "static" ? "border-brand/50 bg-brand/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-accent/50")}>
                <Pin className="h-3.5 w-3.5" /><span><span className="block">Static</span><span className="block text-[10px] text-muted-foreground">fixed count</span></span>
              </button>
              <button onClick={() => canBeDynamic && setMode("dynamic")} disabled={!canBeDynamic}
                title={canBeDynamic ? "" : "Persistent service — can't be dynamic (owns unique data)."}
                className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  mode === "dynamic" ? "border-brand/50 bg-brand/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-accent/50")}>
                <InfinityIcon className="h-3.5 w-3.5" /><span><span className="block">Dynamic</span><span className="block text-[10px] text-muted-foreground">autoscaled</span></span>
              </button>
            </div>
            {!canBeDynamic && <p className="mt-1 text-[10px] text-amber-400/80">Persistent service — stays static (its data is per-instance).</p>}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Num label="Min" value={min} onChange={setMin} />
            <Num label={mode === "dynamic" ? "Max (0=∞)" : "Count"} value={mode === "dynamic" ? max : min} onChange={mode === "dynamic" ? setMax : (v) => { setMin(v); setMax(v); }} />
            <Num label="Players/inst" value={pps} onChange={setPps} min={1} />
          </div>

          {mode === "dynamic" && (
            <div className="grid grid-cols-3 gap-2 rounded-md border border-hairline bg-accent/20 p-2.5">
              <Num label="Warm pool" value={preparedPool} onChange={setPreparedPool} hint="pre-cloned, ready" />
              <Num label="Scale-up" value={scaleUpPercent} onChange={setScaleUpPercent} min={1} suffix="%" hint="% full to add" />
              <Num label="Idle drain" value={scaleDownAfterSec} onChange={setScaleDownAfterSec} suffix="s" hint="reap empty after" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Num label="Cores" value={cores} onChange={setCores} min={1} />
            <Num label="RAM" value={memory} onChange={setMemory} min={128} suffix="MB" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
