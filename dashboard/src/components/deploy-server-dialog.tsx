"use client";

/**
 * Deploy a server into a group/subgroup — opened from the rail context menu (replaces the
 * old "new task" button). Step 1: pick an egg from a Templates-page-style gallery.
 * Step 2: name + scale config. Creates the task via POST /api/tasks.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleDot, roleColor } from "@/components/role-dot";
import { cn } from "@/lib/utils";
import {
  Cable, Gamepad2, Server, Database, Box, Search, ArrowLeft, Rocket,
  Cpu, MemoryStick, HardDrive, Infinity as InfinityIcon, Pin, Loader2,
} from "lucide-react";

type Blueprint = {
  id: string; name: string; role: string; mode: "dynamic" | "static"; persistent?: boolean;
  cores: number; memory: number; disk: number; port: number;
  description: string; software: { kind: string; version: string };
};

const ROLE_ICON: Record<string, React.ElementType> = {
  proxy: Cable, lobby: Gamepad2, smp: Server, db: Database, generic: Box,
};

export function DeployServerDialog({ groupId, groupName, subgroupId, subgroupName, blueprints, open, onOpenChange, onDeployed }: {
  groupId: string;
  groupName: string;
  subgroupId?: string;
  subgroupName?: string;
  blueprints: Blueprint[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDeployed: () => void;
}) {
  const [egg, setEgg] = useState<Blueprint | null>(null);
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"static" | "dynamic">("static");
  const [count, setCount] = useState(1);
  const [maxInst, setMaxInst] = useState(5);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return blueprints.filter((b) =>
      !s || b.name.toLowerCase().includes(s) || b.role.includes(s) || b.software.kind.includes(s),
    );
  }, [blueprints, q]);

  function pick(b: Blueprint) {
    setEgg(b);
    setMode(b.mode);
    setName("");
    setCount(1);
  }

  function reset() {
    setEgg(null);
    setQ("");
    setName("");
  }

  async function deploy() {
    if (!egg || !name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          groupId,
          subgroupId,
          blueprintId: egg.id,
          mode,
          min: mode === "dynamic" ? 1 : count,
          desired: count,
          max: mode === "dynamic" ? maxInst : count,
          autoscale: mode === "dynamic",
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Deploying "${name}" into ${subgroupName ?? groupName}…`);
      onOpenChange(false);
      reset();
      onDeployed();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-brand" />
            {egg ? `Deploy ${egg.name}` : "Deploy a server"}
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              → {groupName}{subgroupName ? ` / ${subgroupName}` : ""}
            </span>
          </DialogTitle>
          <DialogDescription>
            {egg
              ? "Name it and choose how it scales — the controller provisions it in the background."
              : "Pick a template (egg) — same catalog as the Templates page."}
          </DialogDescription>
        </DialogHeader>

        {!egg ? (
          <>
            <div className="flex items-center gap-2 rounded-md border border-hairline px-2.5 py-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search templates…"
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {list.map((b, i) => {
                const Icon = ROLE_ICON[b.role] ?? Box;
                const color = roleColor(b.role);
                return (
                  <button
                    key={b.id}
                    onClick={() => pick(b)}
                    className="player-row-in group flex flex-col rounded-lg border border-hairline bg-panel-2/40 p-3.5 text-left transition-all hover:border-brand/40 hover:bg-accent/40"
                    style={{ animationDelay: `${Math.min(i * 25, 250)}ms` }}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-transform group-hover:scale-110" style={{ background: `color-mix(in oklch, ${color} 14%, transparent)` }}>
                        <Icon className="h-4.5 w-4.5" style={{ color }} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold">{b.name}</div>
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <RoleDot role={b.role} label />
                          <span>·</span>
                          <span className="font-mono">{b.software.kind} {b.software.version}</span>
                        </div>
                      </div>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/80">{b.description}</p>
                    <div className="mt-auto flex items-center gap-3 pt-2.5 font-mono text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1"><Cpu className="h-3 w-3" />{b.cores}c</span>
                      <span className="flex items-center gap-1"><MemoryStick className="h-3 w-3" />{b.memory}MB</span>
                      <span className="flex items-center gap-1"><HardDrive className="h-3 w-3" />{b.disk}GB</span>
                      <span className="ml-auto flex items-center gap-1">
                        {b.mode === "dynamic" ? <InfinityIcon className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                        {b.mode}
                      </span>
                    </div>
                  </button>
                );
              })}
              {list.length === 0 && (
                <p className="col-span-2 py-10 text-center text-sm text-muted-foreground">No templates match.</p>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <button onClick={reset} className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> choose a different template
            </button>

            <div className="space-y-2">
              <Label htmlFor="dep-name">Server name</Label>
              <Input
                id="dep-name"
                autoFocus
                placeholder={egg.role === "lobby" ? "lobby" : egg.role === "proxy" ? "proxy" : "world"}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) deploy(); }}
              />
              {name && (
                <p className="text-xs text-muted-foreground">
                  id: <code className="rounded bg-muted px-1">{groupId}-{name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}</code>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Scaling</Label>
              <div className="flex gap-2">
                {(["static", "dynamic"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[13px] transition-colors",
                      mode === m ? "border-brand/40 bg-brand/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-accent/50",
                    )}
                  >
                    {m === "dynamic" ? <InfinityIcon className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    {m === "dynamic" ? "Dynamic (autoscale)" : "Static (fixed)"}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="dep-count">{mode === "dynamic" ? "Start instances" : "Instances"}</Label>
                <Input id="dep-count" type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value)))} />
              </div>
              {mode === "dynamic" && (
                <div className="space-y-2">
                  <Label htmlFor="dep-max">Max instances</Label>
                  <Input id="dep-max" type="number" min={1} value={maxInst} onChange={(e) => setMaxInst(Math.max(1, Number(e.target.value)))} />
                </div>
              )}
            </div>

            <Button onClick={deploy} disabled={!name.trim() || busy} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              {busy ? "Deploying…" : `Deploy to ${subgroupName ?? groupName}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
