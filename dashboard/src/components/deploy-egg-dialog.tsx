"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { RoleDot, roleColor } from "@/components/role-dot";
import { cn } from "@/lib/utils";
import {
  Rocket, Cpu, MemoryStick, HardDrive, Users, Infinity as InfinityIcon, Pin, Plus, Package,
} from "lucide-react";

type Blueprint = {
  id: string; name: string; role: string; mode: string;
  cores: number; memory: number; disk: number; port: number;
  description: string; software: { kind: string; version: string };
};
type Group = { id: string; name: string };

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

function Num({ value, onChange, min, suffix }: { value: number; onChange: (v: number) => void; min?: number; suffix?: string }) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border border-hairline bg-accent/30">
      <input
        type="number" min={min ?? 0} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-transparent px-2.5 py-1.5 text-sm tabular-nums outline-none"
      />
      {suffix && <span className="shrink-0 border-l border-hairline px-2 text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

export function DeployEggDialog({ egg, onDeployed }: { egg: Blueprint; onDeployed?: () => void }) {
  const color = roleColor(egg.role);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState(egg.name);
  const [groupId, setGroupId] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [mode, setMode] = useState<"dynamic" | "static">(egg.mode === "dynamic" ? "dynamic" : "static");
  const [min, setMin] = useState(1);
  const [max, setMax] = useState(egg.mode === "dynamic" ? 5 : 1);
  const [pps, setPps] = useState(egg.role === "lobby" ? 50 : 80);
  const [preparedPool, setPreparedPool] = useState(0);
  const [scaleUpPercent, setScaleUpPercent] = useState(100);
  const [scaleDownAfterSec, setScaleDownAfterSec] = useState(60);
  const [cores, setCores] = useState(egg.cores);
  const [memory, setMemory] = useState(egg.memory);
  const [disk, setDisk] = useState(egg.disk);
  const [version, setVersion] = useState(egg.software.version);
  const [versions, setVersions] = useState<string[]>([]);
  const [node, setNode] = useState("");
  const [nodes, setNodes] = useState<{ node: string; status: string }[]>([]);
  const [worldUrl, setWorldUrl] = useState("");
  const [plugins, setPlugins] = useState<string[]>([]);
  const [assets, setAssets] = useState<{ kind: string; name: string; ref: string }[]>([]);

  const versioned = egg.software.kind === "paper" || egg.software.kind === "velocity";
  const seedable = egg.role !== "proxy" && egg.software.kind !== "nginx";

  useEffect(() => {
    if (!open) return;
    setName(egg.name);
    setMode(egg.mode === "dynamic" ? "dynamic" : "static");
    setMin(1); setMax(egg.mode === "dynamic" ? 5 : 1);
    setPps(egg.role === "lobby" ? 50 : 80);
    setCores(egg.cores); setMemory(egg.memory); setDisk(egg.disk);
    setVersion(egg.software.version); setNewGroup(""); setNode(""); setWorldUrl(""); setPlugins([]);
    fetch("/api/groups").then((r) => r.json()).then((j) => {
      const gs: Group[] = j.groups ?? [];
      setGroups(gs);
      setGroupId(gs[0]?.id ?? "__new");
    }).catch(() => {});
    fetch("/api/nodes").then((r) => r.json()).then((j) => setNodes(j.nodes ?? [])).catch(() => {});
    if (seedable) fetch("/api/assets").then((r) => r.json()).then((j) => setAssets(j.assets ?? [])).catch(() => {});
    if (versioned) {
      fetch(`/api/versions?kind=${egg.software.kind}`).then((r) => r.json())
        .then((j) => setVersions(Array.isArray(j.versions) ? j.versions : [])).catch(() => {});
    }
  }, [open, egg, versioned, seedable]);

  async function deploy() {
    setBusy(true);
    try {
      let gid = groupId;
      // Create a group on the fly if requested.
      if (gid === "__new") {
        const gn = newGroup.trim();
        if (!gn) throw new Error("Enter a group name");
        const r = await fetch("/api/groups", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: gn }),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        gid = j.group?.id ?? j.id;
      }
      const body: Record<string, unknown> = {
        name: name.trim(), groupId: gid, blueprintId: egg.id, mode,
        min, max, desired: min, cores, memory, disk,
        autoscale: mode === "dynamic", playersPerInstance: pps,
      };
      if (mode === "dynamic") {
        body.preparedPool = preparedPool;
        body.scaleUpPercent = scaleUpPercent;
        body.scaleDownAfterSec = scaleDownAfterSec;
      }
      if (node) body.node = node;
      if (seedable && (worldUrl.trim() || plugins.length)) {
        body.seed = { worldUrl: worldUrl.trim() || undefined, plugins: plugins.length ? plugins : undefined };
      }
      if (versioned && version) body.software = { version };
      const res = await fetch("/api/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Deployed "${name}" from ${egg.name}`);
      setOpen(false);
      onDeployed?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            className="flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors"
            style={{ borderColor: `color-mix(in oklch, ${color} 35%, transparent)`, color, background: `color-mix(in oklch, ${color} 10%, transparent)` }}
          />
        }
      >
        <Rocket className="h-3.5 w-3.5" /> Deploy
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md" style={{ background: `color-mix(in oklch, ${color} 16%, transparent)` }}>
                <Rocket className="h-3.5 w-3.5" style={{ color }} />
              </span>
              Deploy <span style={{ color }}>{egg.name}</span>
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Identity */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Server name">
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-sm outline-none" />
            </Field>
            <Field label="Group">
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)}
                className="w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-sm outline-none">
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                <option value="__new">+ New group…</option>
              </select>
            </Field>
          </div>
          {groupId === "__new" && (
            <Field label="New group name">
              <div className="flex items-center gap-2 rounded-md border border-hairline bg-accent/30 px-2.5">
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="e.g. Survival Network"
                  className="w-full bg-transparent py-1.5 text-sm outline-none" autoFocus />
              </div>
            </Field>
          )}

          <div className={cn("grid gap-3", versioned ? "grid-cols-2" : "grid-cols-1")}>
            {versioned && (
              <Field label="Version">
                <select value={version} onChange={(e) => setVersion(e.target.value)}
                  className="w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-sm outline-none">
                  <option value={egg.software.version}>{egg.software.version} (default)</option>
                  {versions.filter((v) => v !== egg.software.version).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
            )}
            <Field label="Deploy node">
              <select value={node} onChange={(e) => setNode(e.target.value)}
                className="w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-sm outline-none">
                <option value="">Auto (least-loaded)</option>
                {nodes.map((n) => <option key={n.node} value={n.node} disabled={n.status !== "online"}>{n.node}{n.status !== "online" ? " (offline)" : ""}</option>)}
              </select>
            </Field>
          </div>

          {/* Scaling — the core of the egg */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Scaling</span>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              {(["static", "dynamic"] as const).map((md) => (
                <button key={md} onClick={() => setMode(md)}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors",
                    mode === md ? "border-brand/40 bg-brand/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-accent/50",
                  )}>
                  {md === "dynamic" ? <InfinityIcon className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                  <div>
                    <div className="font-medium capitalize">{md}</div>
                    <div className="text-[10px] text-muted-foreground">{md === "dynamic" ? "autoscale on players" : "fixed count"}</div>
                  </div>
                </button>
              ))}
            </div>
            {mode === "dynamic" ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Min"><Num value={min} onChange={setMin} min={0} /></Field>
                  <Field label="Max (0=∞)"><Num value={max} onChange={setMax} min={0} /></Field>
                  <Field label="Players / inst"><Num value={pps} onChange={setPps} min={1} /></Field>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <Field label="Warm pool" hint="Pre-cloned instances kept ready for instant scale-up (needs a fast image).">
                    <Num value={preparedPool} onChange={setPreparedPool} min={0} />
                  </Field>
                  <Field label="Scale-up %" hint="Spawn a spare once a server passes this % full.">
                    <Num value={scaleUpPercent} onChange={setScaleUpPercent} min={1} suffix="%" />
                  </Field>
                  <Field label="Idle drain" hint="Reap an empty instance after this idle time.">
                    <Num value={scaleDownAfterSec} onChange={setScaleDownAfterSec} min={0} suffix="s" />
                  </Field>
                </div>
              </>
            ) : (
              <Field label="Instance count" hint="Fixed number of always-on instances.">
                <Num value={min} onChange={(v) => { setMin(v); setMax(v); }} min={1} />
              </Field>
            )}
          </div>

          {/* Resources */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Resources / instance</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Cores"><Num value={cores} onChange={setCores} min={1} /></Field>
              <Field label="RAM"><Num value={memory} onChange={setMemory} min={128} suffix="MB" /></Field>
              <Field label="Disk"><Num value={disk} onChange={setDisk} min={1} suffix="GB" /></Field>
            </div>
          </div>

          {/* Assets — pick uploaded worlds/plugins (shared store, replicated to all nodes) */}
          {seedable && (assets.length > 0) && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Package className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Assets · applied on provision (cross-node)</span>
              </div>
              {assets.filter((a) => a.kind === "worlds").length > 0 && (
                <div className="mb-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">World</div>
                  <div className="flex flex-wrap gap-1.5">
                    {assets.filter((a) => a.kind === "worlds").map((a) => (
                      <button key={a.ref} type="button" onClick={() => setWorldUrl(worldUrl === a.ref ? "" : a.ref)}
                        className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                          worldUrl === a.ref ? "border-brand/50 bg-brand/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-accent/50")}>
                        <Package className="h-3 w-3" /> {a.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {assets.filter((a) => a.kind === "plugins").length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">Plugins</div>
                  <div className="flex flex-wrap gap-1.5">
                    {assets.filter((a) => a.kind === "plugins").map((a) => {
                      const on = plugins.includes(a.ref);
                      return (
                        <button key={a.ref} type="button" onClick={() => setPlugins((p) => on ? p.filter((x) => x !== a.ref) : [...p, a.ref])}
                          className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                            on ? "border-brand/50 bg-brand/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-accent/50")}>
                          <Package className="h-3 w-3" /> {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-hairline pt-4">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <RoleDot role={egg.role} label /> · {egg.software.kind}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setOpen(false)} className="rounded-md border border-hairline px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50">Cancel</button>
            <button onClick={deploy} disabled={busy || !name.trim()}
              className="flex items-center gap-1.5 rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-40">
              <Rocket className="h-3.5 w-3.5" /> {busy ? "Deploying…" : "Deploy"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
