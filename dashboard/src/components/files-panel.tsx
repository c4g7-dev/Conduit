"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Folder, FileText, ChevronRight, CornerLeftUp, Pencil, Save, X, Trash2, Upload, FolderPlus,
  Download, FileArchive, Loader2, CheckSquare, Square, Copy, Scissors, ClipboardPaste,
} from "lucide-react";

export type FileEntry = { name: string; type: "dir" | "file" | "link"; size: number; mtime: number };

/** Which file backend this panel talks to: the shared store, or a live service container. */
export type FsBackend = { kind: "store" } | { kind: "service"; vmid: number };

function apiBase(b: FsBackend): string {
  return b.kind === "store" ? "/api/files" : `/api/services/${b.vmid}/files`;
}
const joinPath = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;

/** Read a File to base64 (browser-safe; no Node Buffer). */
function fileToB64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(f);
  });
}

/**
 * Full-featured file browser/editor over either backend. Toolbar + right-click context menu +
 * smart multi-select (checkbox mode) + upload/download/archive/rename/copy/cut/paste/delete,
 * with loading feedback. Shared by the global Files page and the inline service browser.
 */
export function FilesPanel({ backend, roots }: { backend: FsBackend; roots: { label: string; path: string }[] }) {
  const base = apiBase(backend);
  const defaultRoot = roots[0]?.path ?? "/opt/mc";
  const [path, setPath] = useState(defaultRoot);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  // selection + clipboard
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clip, setClip] = useState<{ op: "copy" | "cut"; paths: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Reset to the first root only when the backend or the actual root set changes — NOT on
  // every parent re-render (the parent passes a fresh roots array each render).
  const rootSig = (backend.kind === "service" ? `s${backend.vmid}` : "store") + ":" + roots.map((r) => r.path).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPath(roots[0]?.path ?? "/opt/mc"); }, [rootSig]);

  const load = useCallback(async (showSkeleton = false) => {
    setLoading(true); setError(null);
    if (showSkeleton) setEntries(null); // blank old list → skeleton shows instantly on navigate
    try {
      const r = await fetch(`${base}?path=${encodeURIComponent(path)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.error) { setError(j.error); setEntries([]); }
      else setEntries(j.entries ?? []);
    } catch (e) { setError(String(e)); setEntries([]); }
    finally { setLoading(false); }
  }, [base, path]);

  // On a path change show the skeleton immediately (no stale-dir flash); other reloads keep
  // the current list visible to avoid flicker.
  useEffect(() => { load(true); setSelected(new Set()); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const segments = path.replace(/^\//, "").split("/").filter(Boolean);
  const parent = path === defaultRoot ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  const navigable = (p: string) => roots.some((r) => p === r.path || p.startsWith(r.path + "/"));
  const crumbPath = (i: number) => (path.startsWith("/") ? "/" : "") + segments.slice(0, i + 1).join("/");

  async function op(body: Record<string, unknown>, okMsg?: string) {
    setBusy(true);
    try {
      const r = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      if (okMsg) toast.success(okMsg);
      await load();
    } catch (e) { toast.error(String(e)); }
    finally { setBusy(false); }
  }

  // ---- actions ----
  async function mkdir() {
    const name = prompt("New folder name:");
    if (name?.trim()) await op({ action: "mkdir", path: joinPath(path, name.trim()) }, `Created ${name.trim()}`);
  }
  async function rename(e: FileEntry) {
    const name = prompt(`Rename "${e.name}" to:`, e.name);
    if (name?.trim() && name !== e.name) await op({ action: "move", from: joinPath(path, e.name), to: joinPath(path, name.trim()) }, "Renamed");
  }
  async function del(names: string[]) {
    if (!names.length || !confirm(`Delete ${names.length === 1 ? `"${names[0]}"` : `${names.length} items`}? This cannot be undone.`)) return;
    await op({ action: "delete", paths: names.map((n) => joinPath(path, n)) }, `Deleted ${names.length} item(s)`);
    setSelected(new Set());
  }
  async function archive(names: string[]) {
    if (!names.length) return;
    const dest = joinPath(path, names.length === 1 ? `${names[0]}.zip` : `archive-${Date.now()}.zip`);
    await op({ action: "archive", dir: path, names, dest }, "Archived to .zip");
    setSelected(new Set());
  }
  async function paste() {
    if (!clip) return;
    setBusy(true);
    try {
      for (const src of clip.paths) {
        const name = src.split("/").pop()!;
        await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: clip.op === "cut" ? "move" : "copy", from: src, to: joinPath(path, name) }) });
      }
      toast.success(`${clip.op === "cut" ? "Moved" : "Copied"} ${clip.paths.length} item(s)`);
      setClip(null); await load();
    } catch (e) { toast.error(String(e)); } finally { setBusy(false); }
  }
  function download(name: string) {
    const a = document.createElement("a");
    a.href = `${base}?download=1&path=${encodeURIComponent(joinPath(path, name))}`;
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const b64 = await fileToB64(f);
        const r = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "upload", dir: path, name: f.name, content: b64 }) });
        const j = await r.json(); if (j.error) throw new Error(j.error);
      }
      toast.success(`Uploaded ${files.length} file(s)`); await load();
    } catch (e) { toast.error(String(e)); } finally { setBusy(false); }
  }

  // ---- selection helpers ----
  const isSel = (n: string) => selected.has(n);
  function toggle(n: string) {
    setSelected((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); if (x.size === 0) setSelectMode(false); return x; });
  }
  function ctxFor(name: string): string[] {
    // Right-click auto-selects just this item if it isn't already in a multi-selection.
    if (selected.has(name) && selected.size > 1) return [...selected];
    setSelected(new Set([name]));
    return [name];
  }
  const selNames = [...selected];

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline px-2.5 py-2">
        {roots.length > 1 && (
          <div className="mr-1 flex gap-1">
            {roots.map((r) => (
              <button key={r.path} onClick={() => setPath(r.path)}
                className={cn("rounded-md px-2.5 py-1 text-xs transition-colors", path === r.path || path.startsWith(r.path + "/") ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50")}>
                {r.label}
              </button>
            ))}
            <span className="mx-1 h-5 w-px self-center bg-hairline" />
          </div>
        )}
        <TBtn icon={Upload} label="Upload" onClick={() => fileInput.current?.click()} />
        <TBtn icon={FolderPlus} label="New folder" onClick={mkdir} />
        {clip && <TBtn icon={ClipboardPaste} label={`Paste (${clip.paths.length})`} onClick={paste} accent />}
        <span className="flex-1" />
        {selNames.length > 0 && (
          <>
            <span className="px-1 text-[11px] text-muted-foreground">{selNames.length} selected</span>
            <TBtn icon={Download} label="Download" onClick={() => selNames.length === 1 ? download(selNames[0]) : archive(selNames)} />
            <TBtn icon={FileArchive} label="Archive" onClick={() => archive(selNames)} />
            <TBtn icon={Trash2} label="Delete" onClick={() => del(selNames)} danger />
          </>
        )}
        <TBtn icon={selectMode ? CheckSquare : Square} label="Select" onClick={() => { setSelectMode((v) => !v); if (selectMode) setSelected(new Set()); }} active={selectMode} />
        {(loading || busy) && <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 border-b border-hairline px-4 py-2">
        <Folder className="h-3.5 w-3.5 shrink-0 text-brand" />
        {segments.map((seg, i) => {
          const p = crumbPath(i);
          return (
            <span key={p} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
              <button className="rounded px-1 py-0.5 font-mono text-xs transition-colors hover:bg-accent/60 disabled:text-foreground disabled:hover:bg-transparent"
                disabled={!navigable(p) || p === path} onClick={() => setPath(p)}>{seg}</button>
            </span>
          );
        })}
      </div>

      {/* Thin activity bar between the header and the listing — an at-a-glance "working…"
          indicator for ANY operation (listing, upload, delete, move, paste). Reserves its
          1px height even when idle so the layout never jumps. */}
      <div className="h-px overflow-hidden bg-hairline/40">
        {(loading || busy) && (
          <div className="h-full w-1/3 rounded-full bg-brand [animation:fm-sweep_0.9s_ease-in-out_infinite]" />
        )}
      </div>

      {error && <div className="px-4 py-2 text-xs text-destructive">Could not list: {error}</div>}

      {/* Listing — background right-click = paste/new-folder/upload */}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="relative min-h-[40vh]" />}>
          <div key={path} className="animate-in fade-in-0 duration-150">
            {parent && (
              <button onClick={() => setPath(parent)} className="flex w-full items-center gap-2 border-b border-hairline px-4 py-2 text-left text-sm hover:bg-accent/40">
                <CornerLeftUp className="h-4 w-4 text-muted-foreground" /><span className="font-mono text-xs text-muted-foreground">..</span>
              </button>
            )}
            {loading && !entries && Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-hairline px-4 py-2"><div className="h-4 w-4 animate-pulse rounded bg-accent" /><div className="h-3 w-40 animate-pulse rounded bg-accent" /></div>
            ))}
            {(entries ?? []).map((e) => {
              const isDir = e.type === "dir";
              return (
                <ContextMenu key={e.name}>
                  <ContextMenuTrigger
                    render={
                      <div className={cn("group flex items-center gap-2.5 border-b border-hairline px-4 py-2 text-sm last:border-0 transition-colors hover:bg-accent/40", isSel(e.name) && "bg-accent/60")} />
                    }
                  >
                    {selectMode && (
                      <button onClick={() => toggle(e.name)} className="shrink-0">
                        {isSel(e.name) ? <CheckSquare className="h-4 w-4 text-brand" /> : <Square className="h-4 w-4 text-muted-foreground/50" />}
                      </button>
                    )}
                    <button onClick={() => isDir ? setPath(joinPath(path, e.name)) : setViewing(joinPath(path, e.name))} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      {isDir ? <Folder className="h-4 w-4 shrink-0 text-brand/70" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                      <span className="truncate font-mono text-[13px] text-foreground/90">{e.name}</span>
                      {e.type === "link" && <span className="rounded bg-accent px-1.5 py-0.5 text-[9px] text-muted-foreground">link</span>}
                      {!isDir && <span className="ml-auto font-mono text-[11px] text-muted-foreground/60">{bytes(e.size)}</span>}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuLabel>{e.name}</ContextMenuLabel>
                    {!isDir && <ContextMenuItem onClick={() => setViewing(joinPath(path, e.name))}><Pencil /> Open / Edit</ContextMenuItem>}
                    <ContextMenuItem onClick={() => { const n = ctxFor(e.name); n.length === 1 ? download(n[0]) : archive(n); }}><Download /> Download</ContextMenuItem>
                    <ContextMenuItem onClick={() => rename(e)}><Pencil /> Rename</ContextMenuItem>
                    <ContextMenuItem onClick={() => setClip({ op: "copy", paths: ctxFor(e.name).map((n) => joinPath(path, n)) })}><Copy /> Copy</ContextMenuItem>
                    <ContextMenuItem onClick={() => setClip({ op: "cut", paths: ctxFor(e.name).map((n) => joinPath(path, n)) })}><Scissors /> Cut</ContextMenuItem>
                    <ContextMenuItem onClick={() => archive(ctxFor(e.name))}><FileArchive /> Archive (zip)</ContextMenuItem>
                    {/\.(zip|tar|tar\.gz|tgz)$/i.test(e.name) && <ContextMenuItem onClick={() => op({ action: "extract", path: joinPath(path, e.name) }, "Extracted")}><FolderPlus /> Extract here</ContextMenuItem>}
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => { setSelectMode(true); setSelected(new Set([e.name])); }}><CheckSquare /> Select</ContextMenuItem>
                    <ContextMenuItem variant="destructive" onClick={() => del(ctxFor(e.name))}><Trash2 /> Delete</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {!loading && entries && entries.length === 0 && (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">Empty — upload files or create a folder here.</div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => fileInput.current?.click()}><Upload /> Upload here</ContextMenuItem>
          <ContextMenuItem onClick={mkdir}><FolderPlus /> New folder</ContextMenuItem>
          {clip && <ContextMenuItem onClick={paste}><ClipboardPaste /> Paste ({clip.paths.length})</ContextMenuItem>}
        </ContextMenuContent>
      </ContextMenu>

      <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { onUpload(e.target.files); e.target.value = ""; }} />
      {viewing && <FileEditor base={base} path={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function TBtn({ icon: Icon, label, onClick, danger, accent, active }: { icon: React.ElementType; label: string; onClick: () => void; danger?: boolean; accent?: boolean; active?: boolean }) {
  return (
    <button onClick={onClick} title={label}
      className={cn("flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
        danger ? "border-destructive/30 text-destructive hover:bg-destructive/10"
          : accent ? "border-brand/40 bg-brand/10 text-brand hover:bg-brand/20"
          : active ? "border-brand/40 bg-brand/10 text-brand"
          : "border-hairline text-muted-foreground hover:bg-accent/50 hover:text-foreground")}>
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function FileEditor({ base, path, onClose }: { base: string; path: string; onClose: () => void }) {
  const [data, setData] = useState<{ content: string; truncated: boolean; size: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${base}?file=1&path=${encodeURIComponent(path)}`, { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (j.error) setErr(j.error); else { setData(j); setDraft(j.content ?? ""); }
    }).catch((e) => setErr(String(e)));
  }, [base, path]);

  async function save() {
    setSaving(true); setErr(null);
    try {
      const r = await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content: draft }) });
      const j = await r.json(); if (j.error) throw new Error(j.error);
      toast.success("File saved"); setEditing(false);
    } catch (e) { setErr(String(e)); } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogTitle className="break-all font-mono text-sm leading-relaxed">{path}</DialogTitle>
            <div className="flex shrink-0 items-center gap-1">
              {data && !data.truncated && !editing && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setDraft(data.content); setEditing(true); }}><Pencil className="h-3 w-3" /> Edit</Button>}
              {editing && (<>
                <Button size="sm" className="h-7 text-xs" onClick={save} disabled={saving}><Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)}><X className="h-3 w-3" /></Button>
              </>)}
            </div>
          </div>
        </DialogHeader>
        {err && <div className="text-sm text-destructive">{err}</div>}
        {editing ? (
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
            className="h-[60vh] w-full resize-none rounded-md border border-hairline bg-[#1a1b1e] p-3 font-mono text-xs outline-none" style={{ color: "#d4d4d8" }} />
        ) : (
          <pre className="max-h-[65vh] overflow-auto rounded-md border border-hairline bg-[#1a1b1e] p-3 font-mono text-xs whitespace-pre-wrap" style={{ color: "#d4d4d8" }}>{data ? (data.content || "(empty)") : "Loading…"}</pre>
        )}
        {data?.truncated && <p className="text-xs text-amber-400">File is {bytes(data.size)} — showing first part; edit large files via SFTP.</p>}
      </DialogContent>
    </Dialog>
  );
}
