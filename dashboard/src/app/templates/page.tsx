"use client";

import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { NewTemplateDialog } from "@/components/new-template-dialog";
import { DeployEggDialog } from "@/components/deploy-egg-dialog";
import { AssetsSection } from "@/components/assets-section";
import { RoleDot, roleColor } from "@/components/role-dot";
import { bytes, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  HardDrive, LayoutTemplate, Trash2, Cpu, MemoryStick,
  Cable, Gamepad2, Server, Database, Box,
  Infinity as InfinityIcon, Pin, Zap,
} from "lucide-react";

type Blueprint = {
  id: string; name: string; role: string; mode: string;
  cores: number; memory: number; disk: number; port: number;
  description: string; software: { kind: string; version: string };
};
type Data = {
  templates: { volid: string; file: string; os: string; size: number; format: string }[];
  storage: { storage: string; type: string; content: string; avail: number; used: number; total: number }[];
};
type Bps = { blueprints: Blueprint[]; builtin: string[] };

const ROLE_ICON: Record<string, React.ElementType> = {
  proxy: Cable, lobby: Gamepad2, smp: Server, db: Database, generic: Box,
};

function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex items-center justify-between">
      <h2 className="eyebrow">{children}</h2>
      {action}
    </div>
  );
}

type Img = { eggId: string; templates: Record<string, number>; version: number; builtAt: number; building?: boolean; error?: string };

export default function TemplatesPage() {
  const { data, loading, refresh } = usePoll<Data>("/api/templates", 15000);
  const { data: bps, refresh: refreshBps } = usePoll<Bps>("/api/blueprints", 15000);
  const { data: imgs, refresh: refreshImgs } = usePoll<{ images: Img[] }>("/api/images", 6000);
  const builtin = new Set(bps?.builtin ?? []);
  const CLONEABLE = new Set(["paper", "velocity", "nginx"]);

  async function buildImage(eggId: string) {
    await fetch("/api/images/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eggId }) });
    toast.success(`Building fast-clone image for ${eggId}…`);
    setTimeout(refreshImgs, 1000);
  }

  async function delTemplate(id: string) {
    if (!confirm(`Delete egg "${id}"?`)) return;
    const res = await fetch(`/api/blueprints/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (json.error) return toast.error(json.error);
    toast.success("Egg deleted");
    refreshBps();
  }

  return (
    <>
      <PageHeader
        title="Templates"
        subtitle="Deployable server eggs, uploaded assets, and node storage"
        onRefresh={() => { refresh(); refreshBps(); }}
        loading={loading}
      >
        <NewTemplateDialog onCreated={refreshBps} />
      </PageHeader>

      {/* ── Egg gallery ───────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(bps?.blueprints ?? []).map((b) => {
          const Icon = ROLE_ICON[b.role] ?? Box;
          const color = roleColor(b.role);
          const isDynamic = b.mode === "dynamic";
          const isBuiltin = builtin.has(b.id);

          return (
            <div key={b.id} className="group flex flex-col overflow-hidden rounded-lg border border-hairline bg-panel transition-colors hover:border-white/15">
              {/* Header */}
              <div className="flex items-start gap-3 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in oklch, ${color} 14%, transparent)` }}>
                  <Icon className="h-5 w-5" style={{ color }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate font-semibold">{b.name}</div>
                    {isBuiltin ? (
                      <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">built-in</span>
                    ) : (
                      <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0 text-destructive/50 hover:bg-destructive/10 hover:text-destructive" onClick={() => delTemplate(b.id)} title="Delete">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <RoleDot role={b.role} label />
                    <span>·</span>
                    <span className="font-mono">{b.software.kind} {b.software.version}</span>
                  </div>
                </div>
              </div>

              {/* Description */}
              {b.description && (
                <p className="line-clamp-2 px-4 text-[12px] leading-relaxed text-muted-foreground/80">{b.description}</p>
              )}

              {/* Spec strip */}
              <div className="mt-3 flex items-center gap-3 px-4 font-mono text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><Cpu className="h-3 w-3" />{b.cores}c</span>
                <span className="flex items-center gap-1"><MemoryStick className="h-3 w-3" />{b.memory}MB</span>
                <span className="flex items-center gap-1"><HardDrive className="h-3 w-3" />{b.disk}GB</span>
                <span className="ml-auto flex items-center gap-1">
                  {isDynamic ? <InfinityIcon className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                  {b.mode}
                </span>
              </div>

              {/* Fast-clone image status (for autoscaling) */}
              {CLONEABLE.has(b.software.kind) && (() => {
                const img = imgs?.images.find((x) => x.eggId === b.id);
                const nodes = img ? Object.keys(img.templates).length : 0;
                return (
                  <div className="mt-3 flex items-center gap-2 px-4 text-[11px]">
                    <Zap className={cn("h-3 w-3", img && nodes > 0 && !img.building ? "text-brand" : "text-muted-foreground/50")} />
                    <span className="text-muted-foreground">
                      {img?.building ? "building image…"
                        : img && nodes > 0 ? `fast image · ${nodes} node(s) · v${img.version}`
                        : "no fast image"}
                    </span>
                    <button onClick={() => buildImage(b.id)} disabled={img?.building}
                      className="ml-auto rounded border border-hairline px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-50">
                      {img && nodes > 0 ? "Rebuild" : "Build"}
                    </button>
                  </div>
                );
              })()}

              {/* Deploy CTA */}
              <div className="mt-3 border-t border-hairline p-3">
                <DeployEggDialog egg={b} onDeployed={refreshBps} />
              </div>
            </div>
          );
        })}
        {!bps && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-52 rounded-lg" />)}
      </div>

      {/* ── Assets ────────────────────────────────────────────────────── */}
      <SectionLabel>Assets · Worlds &amp; Plugins</SectionLabel>
      <AssetsSection />

      {/* ── Storage ───────────────────────────────────────────────────── */}
      <SectionLabel>Node storage</SectionLabel>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!data && loading && Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        {data?.storage.map((s) => {
          const usedPct = s.total > 0 ? pct(s.used, s.total) : 0;
          const fill = usedPct > 85 ? "#f87171" : usedPct > 65 ? "#fb923c" : "#34d399";
          return (
            <div key={s.storage} className="panel p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><HardDrive className="h-4 w-4 text-muted-foreground" /><span className="font-semibold">{s.storage}</span></div>
                <span className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{s.type}</span>
              </div>
              {s.total > 0 && (
                <div className="mt-3">
                  <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground"><span>{bytes(s.avail)} free</span><span>{Math.round(usedPct)}% used</span></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-accent"><div className="h-full rounded-full transition-all" style={{ width: `${usedPct}%`, background: fill }} /></div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── LXC base images ───────────────────────────────────────────── */}
      <SectionLabel>LXC base images</SectionLabel>
      <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline">
              {["Image", "OS", "Format", "Size"].map((h, i) => (
                <th key={h} className={`px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground ${i === 3 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.templates.map((t) => (
              <tr key={t.volid} className="border-b border-hairline transition-colors last:border-0 hover:bg-accent/40">
                <td className="px-4 py-2.5"><span className="flex items-center gap-2"><LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="font-mono text-xs">{t.file}</span></span></td>
                <td className="px-4 py-2.5"><span className="rounded bg-accent px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{t.os}</span></td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{t.format || (t.file.endsWith(".zst") ? "tar.zst" : "tar.gz")}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">{bytes(t.size)}</td>
              </tr>
            ))}
            {!data && loading && Array.from({ length: 3 }).map((_, i) => (
              <tr key={i}><td colSpan={4} className="px-4 py-2"><Skeleton className="h-4 w-full" /></td></tr>
            ))}
            {data && data.templates.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">No LXC base images downloaded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
