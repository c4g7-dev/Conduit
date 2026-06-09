"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Pencil, Cpu, Users, Globe, Plug, Plus, X, Infinity as InfinityIcon, Pin, Package } from "lucide-react";
import { HelpButton } from "@/components/help-center";
import { cn } from "@/lib/utils";

type Asset = { kind: string; name: string; ref: string; size: number };

const ROLE_COLOR: Record<string, string> = {
  proxy: "#f97316",
  lobby: "#34d399",
  smp: "#38bdf8",
  db: "#a78bfa",
  generic: "#94a3b8",
};

type FrontCandidate = { id: string; name: string; role: string };

function FieldLabel({ children, help }: { children: React.ReactNode; help?: string }) {
  return (
    <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-white/35">
      {children}{help && <HelpButton topic={help} />}
    </div>
  );
}

function NumInput({
  value,
  onChange,
  min,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.04]">
      <input
        type="number"
        min={min ?? 0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-transparent px-3 py-2 text-sm font-medium text-white/80 tabular-nums outline-none"
      />
      {suffix && (
        <span className="shrink-0 border-l border-white/[0.06] px-2.5 text-[11px] text-white/30">
          {suffix}
        </span>
      )}
    </div>
  );
}

export function EditTaskDialog({
  task,
  frontCandidates = [],
  onSaved,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  showTrigger = true,
}: {
  task: {
    id: string;
    name: string;
    role: string;
    fronts: string[];
    mode?: "dynamic" | "static";
    persistent?: boolean;
    node?: string;
    autoscale?: boolean;
    playersPerInstance?: number;
    scaleUpPercent?: number;
    scaleDownAfterSec?: number;
    preparedPool?: number;
    min: number;
    max: number;
    cores: number;
    memory: number;
    disk: number;
    seed?: { worldUrl?: string; plugins?: string[]; icon?: string };
  };
  frontCandidates?: FrontCandidate[];
  onSaved: () => void;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  showTrigger?: boolean;
}) {
  const controlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlled ? controlledOpen : internalOpen;
  const setOpen = (o: boolean) => (controlled ? controlledOnOpenChange?.(o) : setInternalOpen(o));
  const [mode, setMode] = useState<"dynamic" | "static">(task.mode ?? "static");
  const [min, setMin] = useState(task.min);
  const [max, setMax] = useState(task.max);
  const [pps, setPps] = useState(task.playersPerInstance ?? 50);
  const [scaleUpPercent, setScaleUpPercent] = useState(task.scaleUpPercent ?? 100);
  const [scaleDownAfterSec, setScaleDownAfterSec] = useState(task.scaleDownAfterSec ?? 60);
  const [preparedPool, setPreparedPool] = useState(task.preparedPool ?? 0);
  const [cores, setCores] = useState(task.cores);
  const [memory, setMemory] = useState(task.memory);
  const [disk, setDisk] = useState(task.disk);
  const [fronts, setFronts] = useState<string[]>(task.fronts);
  const [worldUrl, setWorldUrl] = useState(task.seed?.worldUrl ?? "");
  const [plugins, setPlugins] = useState<string[]>(task.seed?.plugins ?? []);
  const [pluginInput, setPluginInput] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [node, setNode] = useState(task.node ?? "");
  const [nodes, setNodes] = useState<{ node: string; status: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const color = ROLE_COLOR[task.role] ?? ROLE_COLOR.generic;
  const isSeedable = task.role !== "proxy";
  const canBeDynamic = !task.persistent;

  // load uploaded assets + nodes so the user can pick worlds/plugins + a pinned node
  useEffect(() => {
    if (!open) return;
    fetch("/api/assets").then((r) => r.json()).then((j) => setAssets(j.assets ?? [])).catch(() => {});
    fetch("/api/nodes").then((r) => r.json()).then((j) => setNodes(j.nodes ?? [])).catch(() => {});
  }, [open]);

  function onOpenChange(o: boolean) {
    if (o) {
      setMode(task.mode ?? "static");
      setMin(task.min);
      setMax(task.max);
      setPps(task.playersPerInstance ?? 50);
      setScaleUpPercent(task.scaleUpPercent ?? 100);
      setScaleDownAfterSec(task.scaleDownAfterSec ?? 60);
      setPreparedPool(task.preparedPool ?? 0);
      setCores(task.cores);
      setMemory(task.memory);
      setDisk(task.disk);
      setNode(task.node ?? "");
      setFronts(task.fronts);
      setWorldUrl(task.seed?.worldUrl ?? "");
      setPlugins(task.seed?.plugins ?? []);
      setPluginInput("");
    }
    setOpen(o);
  }

  function toggleFront(id: string) {
    setFronts((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  }

  function addPlugin() {
    const url = pluginInput.trim();
    if (!url || plugins.includes(url)) return;
    setPlugins((p) => [...p, url]);
    setPluginInput("");
  }

  function removePlugin(url: string) {
    setPlugins((p) => p.filter((x) => x !== url));
  }

  async function submit() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        min, max, cores, memory, disk, mode, autoscale: mode === "dynamic", playersPerInstance: pps,
        node: node || "",
      };
      if (mode === "dynamic") {
        body.scaleUpPercent = scaleUpPercent;
        body.scaleDownAfterSec = scaleDownAfterSec;
        body.preparedPool = preparedPool;
      }
      if (task.role === "proxy") body.fronts = fronts;
      if (isSeedable) {
        body.seed = {
          worldUrl: worldUrl.trim() || undefined,
          plugins: plugins.length ? plugins : undefined,
        };
      }
      const res = await fetch("/api/tasks/" + task.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Task "${task.name}" updated`);
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(`Could not update task: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {showTrigger && (
        <DialogTrigger
          render={
            <button
              className="flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand/10 px-2.5 py-1.5 text-[13px] font-medium text-brand transition-colors hover:bg-brand/20"
              title="Edit server"
            />
          }
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            <span className="font-mono text-sm text-white/40">Edit task · </span>
            <span style={{ color }}>{task.name}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Mode (proxies are always static singletons) */}
          {isSeedable && (
            <div>
              <FieldLabel help="mode">Scaling mode</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setMode("static")}
                  className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    mode === "static" ? "border-brand/50 bg-brand/10 text-white/90" : "border-white/[0.08] text-white/40 hover:bg-white/[0.04]")}>
                  <Pin className="h-3.5 w-3.5" /><span><span className="block">Static</span><span className="block text-[10px] text-white/35">fixed count</span></span>
                </button>
                <button type="button" onClick={() => canBeDynamic && setMode("dynamic")} disabled={!canBeDynamic}
                  title={canBeDynamic ? "" : "Persistent service — can't be dynamic (owns unique data)."}
                  className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    mode === "dynamic" ? "border-brand/50 bg-brand/10 text-white/90" : "border-white/[0.08] text-white/40 hover:bg-white/[0.04]")}>
                  <InfinityIcon className="h-3.5 w-3.5" /><span><span className="block">Dynamic</span><span className="block text-[10px] text-white/35">autoscaled</span></span>
                </button>
              </div>
              {!canBeDynamic && <p className="mt-1 text-[10px] text-amber-400/80">Persistent service — stays static (data is per-instance).</p>}
            </div>
          )}

          {/* Scaling */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-white/30" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                Scaling limits
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <FieldLabel help="min-max-desired">Min</FieldLabel>
                <NumInput value={min} onChange={setMin} min={0} />
              </div>
              <div>
                <FieldLabel help="min-max-desired">{mode === "dynamic" ? "Max (0=∞)" : "Count"}</FieldLabel>
                <NumInput value={mode === "dynamic" ? max : min} onChange={mode === "dynamic" ? setMax : (v) => { setMin(v); setMax(v); }} min={0} />
              </div>
              <div>
                <FieldLabel help="players-per-instance">Players/inst</FieldLabel>
                <NumInput value={pps} onChange={setPps} min={1} />
              </div>
            </div>
            {mode === "dynamic" && (
              <div className="mt-2 grid grid-cols-3 gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
                <div><FieldLabel help="prepared-pool">Warm pool</FieldLabel><NumInput value={preparedPool} onChange={setPreparedPool} min={0} /></div>
                <div><FieldLabel help="scale-up-percent">Scale-up</FieldLabel><NumInput value={scaleUpPercent} onChange={setScaleUpPercent} min={1} suffix="%" /></div>
                <div><FieldLabel help="scale-down-after">Idle drain</FieldLabel><NumInput value={scaleDownAfterSec} onChange={setScaleDownAfterSec} min={0} suffix="s" /></div>
              </div>
            )}
          </div>

          {/* Resources */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5 text-white/30" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                Resources · new instances only
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <FieldLabel>Cores</FieldLabel>
                <NumInput value={cores} onChange={setCores} min={1} />
              </div>
              <div>
                <FieldLabel>RAM</FieldLabel>
                <NumInput value={memory} onChange={setMemory} min={128} suffix="MB" />
              </div>
              <div>
                <FieldLabel>Disk</FieldLabel>
                <NumInput value={disk} onChange={setDisk} min={1} suffix="GB" />
              </div>
            </div>
          </div>

          {/* Node pinning */}
          <div>
            <FieldLabel help="node-pin">Pinned node (new instances)</FieldLabel>
            <select value={node} onChange={(e) => setNode(e.target.value)}
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white/80 outline-none">
              <option value="">Auto (least-loaded)</option>
              {nodes.map((n) => <option key={n.node} value={n.node} disabled={n.status !== "online"}>{n.node}{n.status !== "online" ? " (offline)" : ""}</option>)}
            </select>
          </div>

          {/* Fronts */}
          {task.role === "proxy" && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                  Routed backends
                </span>
              </div>
              {frontCandidates.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {frontCandidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleFront(c.id)}
                      className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                        fronts.includes(c.id)
                          ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                          : "border-white/[0.08] text-white/30 hover:border-white/[0.15] hover:text-white/60"
                      }`}
                    >
                      {c.name}
                      <span className="ml-1 opacity-50">· {c.role}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-white/25">
                  No backend tasks available — create them first.
                </p>
              )}
            </div>
          )}

          {/* Seed — world + plugins (non-proxy only) */}
          {isSeedable && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Globe className="h-3.5 w-3.5 text-white/30" />
                <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                  World &amp; plugins · applied on next fresh provision
                </span>
              </div>

              <div>
                <FieldLabel help="seed-assets">World URL (tar.gz or zip)</FieldLabel>
                <div className="flex overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.04]">
                  <input
                    type="url"
                    value={worldUrl}
                    onChange={(e) => setWorldUrl(e.target.value)}
                    placeholder="https://… or conduit-asset:worlds/file.zip"
                    className="w-full bg-transparent px-3 py-2 text-sm text-white/70 placeholder:text-white/20 outline-none"
                  />
                  {worldUrl && (
                    <button
                      type="button"
                      onClick={() => setWorldUrl("")}
                      className="shrink-0 px-2 text-white/20 hover:text-white/50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-white/25">
                  Leave blank to use the blueprint default. Only applied if no world exists yet.
                </p>
                {/* Pick an uploaded world asset (replicated across nodes via the shared store) */}
                {assets.filter((a) => a.kind === "worlds").length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {assets.filter((a) => a.kind === "worlds").map((a) => (
                      <button key={a.ref} type="button" onClick={() => setWorldUrl(a.ref)}
                        className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                          worldUrl === a.ref ? "border-brand/50 bg-brand/10 text-white/85" : "border-white/[0.08] text-white/40 hover:bg-white/[0.04]")}>
                        <Package className="h-3 w-3" /> {a.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <FieldLabel>Plugin JARs</FieldLabel>
                <div className="flex gap-2">
                  <div className="flex flex-1 overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.04]">
                    <Plug className="mx-2.5 my-2 h-3.5 w-3.5 shrink-0 text-white/20" />
                    <input
                      type="url"
                      value={pluginInput}
                      onChange={(e) => setPluginInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPlugin(); } }}
                      placeholder="https://…/plugin.jar  (Enter to add)"
                      className="w-full bg-transparent py-2 pr-3 text-sm text-white/70 placeholder:text-white/20 outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={addPlugin}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/70"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                {/* Pick uploaded plugin assets (shared store, cross-node) */}
                {assets.filter((a) => a.kind === "plugins").length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {assets.filter((a) => a.kind === "plugins").map((a) => {
                      const on = plugins.includes(a.ref);
                      return (
                        <button key={a.ref} type="button"
                          onClick={() => setPlugins((p) => on ? p.filter((x) => x !== a.ref) : [...p, a.ref])}
                          className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                            on ? "border-brand/50 bg-brand/10 text-white/85" : "border-white/[0.08] text-white/40 hover:bg-white/[0.04]")}>
                          <Package className="h-3 w-3" /> {a.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {plugins.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {plugins.map((p) => (
                      <div key={p} className="flex items-center justify-between rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
                        <span className="min-w-0 truncate font-mono text-[11px] text-white/50">
                          {p.split("/").pop() ?? p}
                        </span>
                        <button
                          type="button"
                          onClick={() => removePlugin(p)}
                          className="ml-2 shrink-0 text-white/20 hover:text-red-400"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-white/[0.06] pt-4">
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-sm text-white/40 transition-colors hover:bg-white/[0.04] hover:text-white/60"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-40"
            style={{
              background: `color-mix(in oklch, ${color} 25%, transparent)`,
              border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
              color: `color-mix(in oklch, ${color} 80%, white)`,
            }}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
