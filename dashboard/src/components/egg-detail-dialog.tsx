"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RoleDot } from "@/components/role-dot";
import { cn } from "@/lib/utils";
import { Cpu, MemoryStick, HardDrive, Code2, FileText, Download, Package, Terminal } from "lucide-react";

// Minimal blueprint shape (mirrors the API; only what the detail view reads).
type Custom = { packages?: string; assets?: { url: string; dest: string }[]; installScript?: string; startCommand?: string };
type Egg = {
  id: string; name: string; role: string; mode: string; persistent?: boolean;
  base?: string; cores: number; memory: number; disk: number; port: number;
  description?: string; longDescription?: string; provision?: string;
  software: { kind: string; version: string };
  sharedAssets?: boolean; seed?: unknown; custom?: Custom;
};

/** Per-kind one-liner of what the template fundamentally does (used when no longDescription). */
const KIND_BLURB: Record<string, string> = {
  velocity: "A Velocity proxy: the player-facing edge on :25565. Holds the network slot limit, MOTD and maintenance, and routes players to backend lobbies/SMP servers — including seamless transfers used by world-sharding.",
  paper: "A Paper Minecraft server. Static = persistent world on its own dataset; dynamic = stateless, cloned from a fast image and autoscaled on player count. Carries the Conduit connector for live player data + actions.",
  mariadb: "A shared MariaDB database for the network. Persistent and backed up.",
  redis: "A Redis store for seamless-world player-data sync — inventory / HP / XP / effects travel with a player across shard handoffs.\n\nWhat's special: it's zero-config. The controller designates the lowest-vmid running instance as PRIMARY and auto-wires the rest as REPLICAS (replicaof), re-running only when membership changes, and publishes the endpoint list (primary first). Auth needs no setup either — the password is derived deterministically from the network secret (SHA-256), so the server and every connector compute the same one.\n\nHow servers connect: backends never hardcode an address. The panel hands each sharded server the Redis endpoints + password inside its heartbeat config, so a connector discovers the cluster automatically the moment Redis exists. Its built-in (dependency-free) RESP client tries the endpoints in order — if the primary is down it fails over to a replica.\n\nHow it's used: on a shard boundary cross the source server serializes the player's state (inventory/armor/ender/HP/food/XP/gamemode/effects) to a short-TTL key conduit:pd:<uuid>; the destination reads + applies it on arrival and deletes it. Scale to 2+ for redundancy with automatic failover.",
  nginx: "An nginx web server serving /opt/www, editable via the file manager. Use as a static host or reverse proxy.",
  hytale: "A Hytale server sharing the read-only /assets store. Carries the Conduit Hytale connector so its players appear in the network alongside Minecraft.",
  generic: "A custom container provisioned from a declarative recipe — install packages, pull assets, run an install script, then supervise a start command.",
};

export function EggDetailDialog({ egg, open, onOpenChange }: { egg: Egg; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [tab, setTab] = useState<"overview" | "json">("overview");
  const c = egg.custom;
  const blurb = egg.longDescription || KIND_BLURB[egg.software.kind] || egg.description || "";

  // The JSON of exactly what this template provisions.
  const spec = {
    id: egg.id, name: egg.name, role: egg.role, mode: egg.mode, persistent: egg.persistent,
    software: egg.software,
    resources: { cores: egg.cores, memory: `${egg.memory}MB`, disk: `${egg.disk}GB`, port: egg.port },
    base: egg.base ?? "default (Debian 12)",
    sharedAssets: egg.sharedAssets ?? false,
    seed: egg.seed ?? undefined,
    custom: egg.custom ?? undefined,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {egg.name}
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium lowercase text-muted-foreground">{egg.software.kind} {egg.software.version}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="mb-3 flex gap-1">
          {(["overview", "json"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                tab === t ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:bg-accent")}>
              {t === "overview" ? <FileText className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
              {t === "overview" ? "Overview" : "Spec (JSON)"}
            </button>
          ))}
        </div>

        {tab === "overview" ? (
          <div className="space-y-4">
            <p className="whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{blurb}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat icon={<Cpu className="h-3.5 w-3.5" />} label="Cores" value={`${egg.cores}`} />
              <Stat icon={<MemoryStick className="h-3.5 w-3.5" />} label="Memory" value={`${egg.memory}MB`} />
              <Stat icon={<HardDrive className="h-3.5 w-3.5" />} label="Disk" value={`${egg.disk}GB`} />
              <Stat icon={<RoleDot role={egg.role} />} label="Scaling" value={egg.mode} />
            </div>

            {c && (c.packages || c.assets?.length || c.installScript || c.startCommand) && (
              <div className="space-y-2.5 rounded-md border border-hairline bg-panel/60 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Provisioning recipe</div>
                {c.packages && <Step icon={<Package className="h-3.5 w-3.5" />} title="Packages"><code className="text-[12px]">{c.packages}</code></Step>}
                {c.assets?.length ? (
                  <Step icon={<Download className="h-3.5 w-3.5" />} title="Assets">
                    {c.assets.map((a, i) => <div key={i} className="font-mono text-[11px] text-muted-foreground">{a.url} → <span className="text-foreground">{a.dest}</span></div>)}
                  </Step>
                ) : null}
                {c.installScript && <Step icon={<Terminal className="h-3.5 w-3.5" />} title="Install script"><pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[11px]">{c.installScript}</pre></Step>}
                {c.startCommand && <Step icon={<Terminal className="h-3.5 w-3.5" />} title="Start command"><code className="text-[12px]">{c.startCommand}</code></Step>}
              </div>
            )}
          </div>
        ) : (
          <pre className="overflow-x-auto rounded-md border border-hairline bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {JSON.stringify(spec, null, 2)}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-hairline bg-panel/60 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Step({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-foreground">{icon}{title}</div>
      <div className="pl-5">{children}</div>
    </div>
  );
}
