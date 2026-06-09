"use client";

import { useState } from "react";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { FilesPanel, type FsBackend } from "@/components/files-panel";
import { Box, ServerCog } from "lucide-react";

type ConduitState = { groups: { tasks: { id: string; name: string; softwareKind: string; instances: { vmid: number; status: string }[] }[] }[] };

// Shared-store roots (paths are store-relative).
const STORE_ROOTS = [
  { id: "overlays", label: "Overlays", hint: "file trees layered onto services", path: "overlays" },
  { id: "tasks", label: "Tasks", hint: "per-task config + task.yaml", path: "tasks" },
  { id: "assets", label: "Assets", hint: "worlds · plugins · configs", path: "assets" },
  { id: "services", label: "Services", hint: "per-service shared config", path: "services" },
];

// In-container roots per service kind (absolute paths).
function serviceRoots(kind: string): { label: string; path: string }[] {
  if (kind === "hytale") return [{ label: "Server data", path: "/opt/hytale/data" }, { label: "Launcher", path: "/opt/hytale" }, { label: "Shared", path: "/opt/shared" }];
  if (kind === "nginx") return [{ label: "Web root", path: "/opt/www" }, { label: "Config", path: "/opt/nginx" }];
  return [{ label: "Server", path: "/opt/mc" }, { label: "Shared", path: "/opt/shared" }];
}

export default function FilesPage() {
  const { data: state } = usePoll<ConduitState>("/api/conduit/state", 10000);
  const [sel, setSel] = useState<{ type: "store"; root: string } | { type: "service"; vmid: number; name: string; kind: string }>({ type: "store", root: "overlays" });

  const services = (state?.groups ?? []).flatMap((g) =>
    g.tasks.flatMap((t) => t.instances.filter((i) => i.status === "running").map((i) => ({ vmid: i.vmid, name: t.name, kind: t.softwareKind }))));

  // Build the FilesPanel backend + roots for the current selection.
  const backend: FsBackend = sel.type === "store" ? { kind: "store" } : { kind: "service", vmid: sel.vmid };
  const roots = sel.type === "store"
    ? [STORE_ROOTS.find((r) => r.id === sel.root) ?? STORE_ROOTS[0]].map((r) => ({ label: r.label, path: r.path }))
    : serviceRoots(sel.kind);

  return (
    <>
      <PageHeader title="Files" subtitle="Shared store (replicated across all nodes) + live service files" />

      <div className="flex gap-4">
        {/* Sidebar: roots + services */}
        <div className="w-56 shrink-0 space-y-4">
          <div className="panel p-2">
            <div className="eyebrow px-2 py-1">Shared store</div>
            {STORE_ROOTS.map((r) => {
              const active = sel.type === "store" && sel.root === r.id;
              return (
                <button key={r.id} onClick={() => setSel({ type: "store", root: r.id })}
                  className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors", active ? "bg-accent" : "hover:bg-accent/50")}>
                  <Box className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", active ? "text-brand" : "text-muted-foreground")} />
                  <span><span className="block text-[13px]">{r.label}</span><span className="block text-[10px] text-muted-foreground/70">{r.hint}</span></span>
                </button>
              );
            })}
          </div>
          <div className="panel p-2">
            <div className="eyebrow px-2 py-1">Live services</div>
            {services.map((s) => {
              const active = sel.type === "service" && sel.vmid === s.vmid;
              return (
                <button key={s.vmid} onClick={() => setSel({ type: "service", vmid: s.vmid, name: s.name, kind: s.kind })}
                  className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}>
                  <ServerCog className={cn("h-3.5 w-3.5 shrink-0", active && "text-brand")} /> <span className="truncate">{s.name}</span><span className="ml-auto text-[10px] text-muted-foreground/50">#{s.vmid}</span>
                </button>
              );
            })}
            {services.length === 0 && <p className="px-2 py-1 text-[11px] text-muted-foreground/60">none running</p>}
          </div>
        </div>

        {/* Browser */}
        <div className="min-w-0 flex-1">
          {sel.type === "service" && (
            <div className="mb-2 flex items-center gap-2 text-[13px] text-muted-foreground">
              <ServerCog className="h-3.5 w-3.5 text-brand" />
              <span className="text-foreground">{sel.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground/60">#{sel.vmid} · {sel.kind} · live container files</span>
            </div>
          )}
          <FilesPanel key={sel.type === "store" ? `store:${sel.root}` : `svc:${sel.vmid}`} backend={backend} roots={roots} />
        </div>
      </div>
    </>
  );
}
