"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { bytes } from "@/lib/format";
import { Folder, FileText, ChevronRight, CornerLeftUp, Pencil, Save, X } from "lucide-react";

export type FileEntry = { name: string; type: "dir" | "file" | "link"; size: number; mtime: number };

/**
 * In-container file browser/editor for a service (reads/writes /opt via the agent).
 * Shared by the service detail page and the global Files page (Services root) so live
 * service files are edited inline — no redirect.
 */
export function FilesPanel({ vmid, roots }: { vmid: number; roots: { label: string; path: string }[] }) {
  const defaultRoot = roots[0]?.path ?? "/opt/mc";
  const [path, setPath] = useState(defaultRoot);
  useEffect(() => { setPath(roots[0]?.path ?? "/opt/mc"); }, [vmid, roots]);
  const { data, error, loading } = usePoll<{ path: string; entries: FileEntry[] }>(
    `/api/services/${vmid}/files?path=${encodeURIComponent(path)}`,
    8000,
  );
  const [viewing, setViewing] = useState<string | null>(null);

  const segments = path.replace(/^\//, "").split("/");
  const parent = path === defaultRoot ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  const crumbPath = (idx: number) => "/" + segments.slice(0, idx + 1).join("/");

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
      {roots.length > 1 && (
        <div className="flex gap-1 border-b border-hairline px-3 py-2">
          {roots.map((r) => (
            <button key={r.path} onClick={() => setPath(r.path)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${path === r.path || path.startsWith(r.path + "/") ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}>
              {r.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 border-b border-hairline px-4 py-2.5">
        <Folder className="h-3.5 w-3.5 shrink-0 text-brand" />
        {segments.map((seg, i) => {
          const p = crumbPath(i);
          const navigable = roots.some((r) => p === r.path || p.startsWith(r.path + "/"));
          return (
            <span key={p} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
              <button className="rounded px-1 py-0.5 font-mono text-xs transition-colors hover:bg-accent/60 disabled:text-foreground disabled:hover:bg-transparent"
                disabled={!navigable || p === path} onClick={() => setPath(p)}>{seg}</button>
            </span>
          );
        })}
      </div>

      {error && <div className="px-4 py-2 text-xs text-destructive">Could not list: {error}</div>}

      <div className="max-h-[64vh] overflow-y-auto">
        {parent && (
          <button className="flex w-full items-center gap-2 border-b border-hairline px-4 py-2 text-left text-sm hover:bg-accent/40" onClick={() => setPath(parent)}>
            <CornerLeftUp className="h-4 w-4 text-muted-foreground" /><span className="font-mono text-xs text-muted-foreground">..</span>
          </button>
        )}
        {(data?.entries ?? []).map((e) => {
          const full = `${path === "/" ? "" : path}/${e.name}`;
          const isDir = e.type === "dir";
          return (
            <button key={e.name} className="flex w-full items-center gap-3 border-b border-hairline px-4 py-2 text-left text-sm last:border-0 hover:bg-accent/40"
              onClick={() => (isDir ? setPath(full) : setViewing(full))}>
              {isDir ? <Folder className="h-4 w-4 shrink-0 text-brand/70" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className="flex-1 truncate font-mono text-sm text-foreground/80">{e.name}</span>
              {e.type === "link" && <span className="rounded bg-accent px-1.5 py-0.5 text-[9px] text-muted-foreground">link</span>}
              {!isDir && <span className="font-mono text-[11px] text-muted-foreground/60">{bytes(e.size)}</span>}
            </button>
          );
        })}
        {!loading && (data?.entries?.length ?? 0) === 0 && !parent && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">Empty directory.</div>
        )}
      </div>

      {viewing && <FileViewer vmid={vmid} path={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function FileViewer({ vmid, path, onClose }: { vmid: number; path: string; onClose: () => void }) {
  const { data, error, loading } = usePoll<{ content: string; truncated: boolean; size: number }>(
    `/api/services/${vmid}/files?path=${encodeURIComponent(path)}&file=1`, 600_000,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (data?.content != null && !editing) setDraft(data.content); }, [data?.content, editing]);

  async function save() {
    setSaving(true); setSaveError(null);
    try {
      const res = await fetch(`/api/services/${vmid}/files`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content: draft }) });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success("File saved"); setEditing(false);
    } catch (e) { setSaveError(String(e)); } finally { setSaving(false); }
  }

  const editable = !data?.truncated;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogTitle className="break-all font-mono text-sm leading-relaxed">{path}</DialogTitle>
            <div className="flex shrink-0 items-center gap-1">
              {editable && !editing && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setDraft(data?.content ?? ""); setEditing(true); }}><Pencil className="h-3 w-3" /> Edit</Button>}
              {editing && (<>
                <Button size="sm" className="h-7 text-xs" onClick={save} disabled={saving}><Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)}><X className="h-3 w-3" /></Button>
              </>)}
            </div>
          </div>
        </DialogHeader>
        {(error || saveError) && <div className="text-sm text-destructive">{error ?? saveError}</div>}
        {editing ? (
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
            className="h-[60vh] w-full resize-none rounded-md border border-hairline bg-[#16191e] p-3 font-mono text-xs outline-none" style={{ color: "#c9d1d9" }} />
        ) : (
          <pre className="max-h-[65vh] overflow-auto rounded-md border border-hairline bg-[#16191e] p-3 font-mono text-xs whitespace-pre-wrap" style={{ color: "#c9d1d9" }}>{loading ? "Loading…" : data?.content || "(empty)"}</pre>
        )}
        {data?.truncated && <p className="text-xs text-amber-400">File is {bytes(data.size)} — showing first 256 KB. Editing disabled for large files.</p>}
      </DialogContent>
    </Dialog>
  );
}
