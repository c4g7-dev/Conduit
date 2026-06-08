"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FilesPanel } from "@/components/files-panel";
import {
  Folder, FileText, ChevronRight, CornerLeftUp, Save, X, Trash2, FolderPlus, Box, ServerCog, Loader2,
} from "lucide-react";

// In-container roots per service kind (mirrors the service detail page).
function serviceRoots(kind: string): { label: string; path: string }[] {
  if (kind === "hytale") return [{ label: "Server data", path: "/opt/hytale/data" }, { label: "Launcher", path: "/opt/hytale" }];
  if (kind === "nginx") return [{ label: "Web root", path: "/opt/www" }];
  return [{ label: "Server", path: "/opt/mc" }, { label: "Shared", path: "/opt/shared" }];
}

type Entry = { name: string; type: "dir" | "file"; size: number; mtime: number };
type ConduitState = { groups: { tasks: { id: string; name: string; softwareKind: string; instances: { vmid: number; status: string }[] }[] }[] };

// The CloudNet-style roots on the shared store.
const ROOTS = [
  { id: "overlays", label: "Overlays", hint: "file trees layered onto services" },
  { id: "tasks", label: "Tasks", hint: "per-task config overlays" },
  { id: "assets", label: "Assets", hint: "worlds · plugins · configs" },
];

export default function FilesPage() {
  const [root, setRoot] = useState("overlays");
  const [path, setPath] = useState("overlays");
  const { data, error, loading, refresh } = usePoll<{ path: string; entries: Entry[] }>(
    `/api/files?path=${encodeURIComponent(path)}`, 15000,
  );
  const { data: state } = usePoll<ConduitState>("/api/conduit/state", 10000);
  const [viewing, setViewing] = useState<string | null>(null);
  // When a live service is selected, the right pane shows its in-container files inline.
  const [svc, setSvc] = useState<{ vmid: number; name: string; kind: string } | null>(null);

  const segs = path.split("/").filter(Boolean);
  const parent = segs.length > 1 ? segs.slice(0, -1).join("/") : null;

  async function mkdir() {
    const name = prompt("New folder name:");
    if (!name) return;
    await fetch("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "mkdir", path: `${path}/${name}` }) });
    refresh();
  }
  async function del(e: Entry) {
    if (!confirm(`Delete "${e.name}"?`)) return;
    await fetch("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", path: `${path}/${e.name}` }) });
    toast.success(`Deleted ${e.name}`); refresh();
  }

  const services = (state?.groups ?? []).flatMap((g) => g.tasks.flatMap((t) => t.instances.filter((i) => i.status === "running").map((i) => ({ vmid: i.vmid, name: t.name, kind: t.softwareKind }))));

  return (
    <>
      <PageHeader title="Files" subtitle="Shared template store (replicated across all nodes) + live service files" onRefresh={refresh} loading={loading}>
        <button onClick={mkdir} className="flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50"><FolderPlus className="h-3.5 w-3.5" /> New folder</button>
      </PageHeader>

      <div className="flex gap-4">
        {/* Roots */}
        <div className="w-56 shrink-0 space-y-4">
          <div className="panel p-2">
            <div className="eyebrow px-2 py-1">Shared store</div>
            {ROOTS.map((r) => (
              <button key={r.id} onClick={() => { setRoot(r.id); setPath(r.id); setSvc(null); }}
                className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors", !svc && root === r.id ? "bg-accent" : "hover:bg-accent/50")}>
                <Box className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", !svc && root === r.id ? "text-brand" : "text-muted-foreground")} />
                <span><span className="block text-[13px]">{r.label}</span><span className="block text-[10px] text-muted-foreground/70">{r.hint}</span></span>
              </button>
            ))}
          </div>
          <div className="panel p-2">
            <div className="eyebrow px-2 py-1">Live services</div>
            {services.map((s) => (
              <button key={s.vmid} onClick={() => setSvc(s)}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors", svc?.vmid === s.vmid ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}>
                <ServerCog className={cn("h-3.5 w-3.5 shrink-0", svc?.vmid === s.vmid && "text-brand")} /> <span className="truncate">{s.name}</span><span className="ml-auto text-[10px] text-muted-foreground/50">#{s.vmid}</span>
              </button>
            ))}
            {services.length === 0 && <p className="px-2 py-1 text-[11px] text-muted-foreground/60">none running</p>}
          </div>
        </div>

        {/* Browser */}
        {svc ? (
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-2 text-[13px] text-muted-foreground">
              <ServerCog className="h-3.5 w-3.5 text-brand" />
              <span className="text-foreground">{svc.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground/60">#{svc.vmid} · {svc.kind}</span>
              <span className="text-[11px]">· live container files</span>
            </div>
            <FilesPanel vmid={svc.vmid} roots={serviceRoots(svc.kind)} />
          </div>
        ) : (
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-hairline bg-panel">
          <div className="flex flex-wrap items-center gap-1 border-b border-hairline px-4 py-2.5">
            <Folder className="h-3.5 w-3.5 shrink-0 text-brand" />
            {segs.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
                <button onClick={() => setPath(segs.slice(0, i + 1).join("/"))} disabled={i === segs.length - 1}
                  className="rounded px-1 py-0.5 font-mono text-xs transition-colors hover:bg-accent/60 disabled:text-foreground disabled:hover:bg-transparent">{seg}</button>
              </span>
            ))}
          </div>
          {error && <div className="px-4 py-2 text-xs text-destructive">Could not list: {error}</div>}
          <div>
            {parent && (
              <button onClick={() => setPath(parent)} className="flex w-full items-center gap-2 border-b border-hairline px-4 py-2 text-left text-sm hover:bg-accent/40">
                <CornerLeftUp className="h-4 w-4 text-muted-foreground" /><span className="font-mono text-xs text-muted-foreground">..</span>
              </button>
            )}
            {(data?.entries ?? []).map((e) => (
              <div key={e.name} className="group flex items-center gap-3 border-b border-hairline px-4 py-2 text-sm last:border-0 hover:bg-accent/40">
                <button onClick={() => e.type === "dir" ? setPath(`${path}/${e.name}`) : setViewing(`${path}/${e.name}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  {e.type === "dir" ? <Folder className="h-4 w-4 shrink-0 text-brand/70" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className="truncate font-mono text-[13px]">{e.name}</span>
                  {e.type === "file" && <span className="ml-auto font-mono text-[11px] text-muted-foreground/60">{bytes(e.size)}</span>}
                </button>
                <button onClick={() => del(e)} className="rounded p-1 text-muted-foreground/50 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            {data && data.entries.length === 0 && !parent && (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">Empty — create folders/files here; they replicate to every node.</div>
            )}
            {data && data.entries.length === 0 && parent && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">Empty directory.</div>
            )}
          </div>
        </div>
        )}
      </div>

      {viewing && <FileEditor path={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function FileEditor({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/files?file=1&path=${encodeURIComponent(path)}`).then((r) => r.json()).then((j) => {
      if (j.error) { toast.error(j.error); setContent(""); } else { setContent(j.content ?? ""); setTruncated(!!j.truncated); }
    });
  }, [path]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/files", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }) });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      toast.success("Saved · replicated to all nodes"); onClose();
    } catch (e) { toast.error(String(e)); } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-8">
            <DialogTitle className="break-all font-mono text-sm">{path}</DialogTitle>
            <button onClick={save} disabled={saving || content === null} className="flex shrink-0 items-center gap-1.5 rounded-md bg-brand px-3 py-1 text-xs font-medium text-brand-foreground hover:opacity-90 disabled:opacity-40">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
            </button>
          </div>
        </DialogHeader>
        {content === null ? (
          <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false}
            className="h-[60vh] w-full resize-none rounded-md border border-hairline bg-[#16191e] p-3 font-mono text-xs outline-none" style={{ color: "#c9d1d9" }} />
        )}
        {truncated && <p className="text-xs text-amber-400">File is large — showing first 2 MB; saving would truncate, edit via SFTP instead.</p>}
        <div className="flex justify-end"><button onClick={onClose} className="flex items-center gap-1 rounded-md border border-hairline px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50"><X className="h-3.5 w-3.5" /> Close</button></div>
      </DialogContent>
    </Dialog>
  );
}
