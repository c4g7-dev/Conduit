"use client";

import React, { use, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { bytes } from "@/lib/format";
import {
  ChevronRight,
  Folder,
  FileText,
  CornerLeftUp,
  AlertTriangle,
  Terminal,
  Pencil,
  Save,
  X,
  Circle,
  Send,
  Loader2,
  Activity,
} from "lucide-react";
import { Sparkline } from "@/components/sparkline";
import AnsiToHtml from "ansi-to-html";
import "@xterm/xterm/css/xterm.css";

const ansi = new AnsiToHtml({ escapeXML: true, fg: "#c9d1d9", bg: "transparent", newline: false });

/**
 * Strip terminal control sequences that aren't colour (SGR) codes — cursor moves,
 * private modes (`\x1b[?...h/l`), bracketed-paste, keypad, OSC titles, etc. — so the
 * tmux pane snapshot doesn't render as junk. SGR (`\x1b[...m`) is preserved for colour.
 */
function sanitizeAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC … BEL/ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[=>]/g, "")                            // keypad modes
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-ln-~]/g, "")          // all CSI except 'm' (SGR)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, ""); // stray control chars (keep \t,\n,\r,ESC)
}

function toHtml(text: string): string {
  if (!text) return "";
  try { return ansi.toHtml(sanitizeAnsi(text)); } catch { return text; }
}

type FileEntry = {
  name: string;
  type: "dir" | "file" | "link";
  size: number;
  mtime: number;
};

type StateTask = {
  id: string;
  name: string;
  mode: "dynamic" | "static";
  softwareKind?: string;
  instances: { vmid: number; ip: string | null; status: string; name: string; ready: boolean }[];
};
type StateGroup = { id: string; name: string; tasks: StateTask[] };

function filePanelRoots(softwareKind?: string): { label: string; path: string }[] {
  if (softwareKind === "hytale") {
    return [
      { label: "Server data", path: "/opt/hytale/data" },
      { label: "Launcher", path: "/opt/hytale" },
    ];
  }
  return [{ label: "Server", path: "/opt/mc" }];
}

export default function ServiceDetailPage({
  params,
}: {
  params: Promise<{ vmid: string }>;
}) {
  const { vmid } = use(params);
  const id = Number(vmid);

  const { data: state } = usePoll<{ groups: StateGroup[] }>(
    "/api/conduit/state",
    10_000,
  );
  const owner = useMemo(() => {
    for (const g of state?.groups ?? []) {
      for (const t of g.tasks) {
        const inst = t.instances.find((i) => i.vmid === id);
        if (inst) return { group: g, task: t, inst };
      }
    }
    return null;
  }, [state, id]);

  const isDynamic = owner?.task.mode === "dynamic";

  return (
    <>
      <PageHeader
        title={owner ? `${owner.task.name} #${id}` : `Service #${id}`}
        subtitle={
          owner
            ? `${owner.group.name} · ${owner.inst.ip ?? "…"} · ${owner.inst.status}`
            : `Live console and files for container ${id}`
        }
      />

      {isDynamic && (
        <div className="mb-6 flex items-center gap-2.5 rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Dynamic service — files are <strong>not persistent</strong> and will be lost when it
            scales down.
          </span>
        </div>
      )}

      <Tabs defaultValue="console">
        <TabsList className="mb-4">
          <TabsTrigger value="console">
            <Terminal className="h-4 w-4" /> Console
          </TabsTrigger>
          <TabsTrigger value="metrics">
            <Activity className="h-4 w-4" /> Metrics
          </TabsTrigger>
          <TabsTrigger value="files">
            <Folder className="h-4 w-4" /> Files
          </TabsTrigger>
        </TabsList>
        <TabsContent value="console">
          <ConsolePanel vmid={id} owner={owner} />
        </TabsContent>
        <TabsContent value="metrics">
          <MetricsPanel vmid={id} />
        </TabsContent>
        <TabsContent value="files">
          <FilesPanel vmid={id} roots={filePanelRoots(owner?.task.softwareKind)} />
        </TabsContent>
      </Tabs>
    </>
  );
}

/* ---- Install log (SSE — during provisioning) ------------------------------ */

function InstallLogPanel({ vmid }: { vmid: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const es = new EventSource(`/api/services/${vmid}/install-log`);
    es.onmessage = (e) => {
      try {
        const chunk = atob(e.data);
        setLines((prev) => [...prev, ...chunk.split("\n").filter(Boolean)]);
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [vmid]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="overflow-hidden rounded-xl border border-amber-400/20 bg-[#0d0a05]">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-amber-400/10 bg-amber-400/5 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400/70" />
          <span className="font-mono text-xs text-amber-300/70">
            Installing software — this takes 3–10 min
          </span>
        </div>
        <span className="text-[11px] text-amber-400/40">
          {lines.length} lines
        </span>
      </div>

      {/* Log output */}
      <div
        ref={boxRef as React.RefObject<HTMLDivElement>}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
        className="h-[62vh] overflow-auto p-4 font-mono text-[11px] leading-[1.6]"
        style={{ background: "#080600", color: "#d4b483" }}
      >
        {lines.length === 0 ? (
          <span className="opacity-40">Waiting for install output… (container may still be starting up)</span>
        ) : (
          <pre
            className="whitespace-pre-wrap"
            dangerouslySetInnerHTML={{ __html: toHtml(lines.join("\n")) }}
          />
        )}
      </div>
    </div>
  );
}

/* ---- Console (xterm.js over WebSocket, SSE fallback) ---------------------- */

function ConsolePanel({
  vmid,
  owner,
}: {
  vmid: number;
  owner: { task: StateTask; inst: { status: string; ready: boolean } } | null;
}) {
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<"ws" | "sse" | null>(null);

  const termHostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);

  const isReady = owner?.inst.ready !== false;
  const softwareKind = owner?.task.softwareKind ?? "mc";
  const status = owner?.inst.status ?? "unknown";

  useEffect(() => {
    if (!isReady) return;
    let disposed = false;
    let es: EventSource | null = null;
    let resizeObs: ResizeObserver | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fit: any = null;

    // Local line-editing state (refs so the once-registered onData handler stays current).
    const line = { buf: "" };
    const hist: string[] = [];
    let histIdx = -1;
    let draft = "";

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !termHostRef.current) return;

      const term = new Terminal({
        // xterm renders to canvas — use a guaranteed system monospace (next/font's
        // Geist Mono has a hashed family name that canvas can't resolve).
        fontFamily: "ui-monospace, 'DejaVu Sans Mono', 'SF Mono', Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.2,
        letterSpacing: 0,
        cursorBlink: true,
        scrollback: 5000,
        theme: {
          background: "#16191e",
          foreground: "#c9d1d9",
          cursor: "#f6821f",
          selectionBackground: "#2d4f67",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termHostRef.current);
      fit.fit();
      term.focus();
      termRef.current = term;

      resizeObs = new ResizeObserver(() => { try { fit.fit(); } catch {} });
      resizeObs.observe(termHostRef.current);

      function sendLine(cmd: string) {
        const ws = wsRef.current;
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: cmd }));
        } else {
          fetch(`/api/services/${vmid}/console`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: cmd }),
          }).catch((e) => toast.error(`Failed to send: ${String(e)}`));
        }
      }
      function eraseLine() {
        if (line.buf.length) term.write("\b \b".repeat(line.buf.length));
        line.buf = "";
      }
      function replaceLine(s: string) { eraseLine(); term.write(s); line.buf = s; }

      // Direct terminal input — type straight into the console (no separate input box).
      // We locally echo for instant feedback, then erase on Enter so the server's own
      // console echo is the single source of truth (no double echo).
      term.onData((d: string) => {
        if (d === "[A") { // ↑ history
          if (!hist.length) return;
          if (histIdx === -1) draft = line.buf;
          histIdx = Math.min(histIdx + 1, hist.length - 1);
          replaceLine(hist[histIdx]);
        } else if (d === "[B") { // ↓ history
          if (histIdx <= 0) { histIdx = -1; replaceLine(draft); }
          else { histIdx -= 1; replaceLine(hist[histIdx]); }
        } else if (d === "\r") { // Enter
          const cmd = line.buf;
          eraseLine();
          if (cmd.trim()) { hist.unshift(cmd); if (hist.length > 200) hist.pop(); sendLine(cmd); }
          histIdx = -1; draft = "";
        } else if (d === "") { // Backspace
          if (line.buf.length) { line.buf = line.buf.slice(0, -1); term.write("\b \b"); }
        } else if (d === "") { // Ctrl-C → clear current line
          eraseLine(); histIdx = -1;
        } else if (d >= " " || d === "\t") { // printable / paste
          const clean = d.replace(/[\r\n]+/g, " ");
          line.buf += clean;
          term.write(clean);
        }
      });

      // --- transport: prefer the WS console proxy, fall back to SSE ---
      let wsOk = false;
      try {
        const r = await fetch(`/api/services/${vmid}/agent`);
        const { agent, consolePort } = await r.json();
        if (agent && consolePort) {
          const proto = location.protocol === "https:" ? "wss" : "ws";
          const url = `${proto}://${location.hostname}:${consolePort}/console?vmid=${vmid}&agent=${encodeURIComponent(agent)}`;
          const ws = new WebSocket(url);
          wsRef.current = ws;
          ws.onopen = () => { wsOk = true; if (!disposed) { setConnected(true); setTransport("ws"); } };
          ws.onmessage = (e) => {
            try {
              const f = JSON.parse(e.data);
              if (f.type === "history") { term.clear(); term.write(String(f.data ?? "")); }
              else if (f.type === "output") term.write(String(f.data ?? ""));
            } catch { /* ignore */ }
          };
          ws.onclose = () => {
            wsRef.current = null;
            if (!disposed && !wsOk) startSse();
            else if (!disposed) setConnected(false);
          };
          ws.onerror = () => { try { ws.close(); } catch {} };
          setTimeout(() => { if (!disposed && !wsOk) { try { ws.close(); } catch {} } }, 2500);
        } else {
          startSse();
        }
      } catch {
        startSse();
      }

      function startSse() {
        if (disposed || es) return;
        setTransport("sse");
        es = new EventSource(`/api/services/${vmid}/console/stream`);
        let last = "";
        es.onopen = () => { if (!disposed) setConnected(true); };
        es.onmessage = (e) => {
          try {
            const text = atob(e.data);
            if (text.startsWith(last)) term.write(text.slice(last.length));
            else { term.clear(); term.write(text); }
            last = text;
          } catch { /* ignore */ }
        };
        es.onerror = () => { if (!disposed) setConnected(false); };
      }
    })();

    return () => {
      disposed = true;
      try { wsRef.current?.close(); } catch {}
      try { es?.close(); } catch {}
      try { resizeObs?.disconnect(); } catch {}
      try { termRef.current?.dispose(); } catch {}
      termRef.current = null;
      wsRef.current = null;
    };
  }, [vmid, isReady]);

  if (!isReady) return <InstallLogPanel vmid={vmid} />;

  return (
    <div className="overflow-hidden rounded-lg border border-hairline" style={{ background: "#16191e" }}>
      {/* Terminal title bar */}
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2">
        <div className="flex items-center gap-2.5">
          <div className="flex gap-1.5">
            <div className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
            <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
            <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          </div>
          <span className="font-mono text-xs text-muted-foreground">{softwareKind}@{vmid} — tmux</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Circle className={`h-2 w-2 fill-current ${connected ? "text-emerald-400" : "text-muted-foreground/40"}`} />
          <span className="text-[11px] text-muted-foreground">
            {connected ? (transport === "ws" ? "live · ws" : "live") : "connecting…"}
          </span>
          <Badge variant="outline" className="ml-1 border-hairline text-[10px] text-muted-foreground">{status}</Badge>
        </div>
      </div>

      {/* Interactive xterm.js terminal — type directly here (↑↓ history) */}
      <div
        ref={termHostRef}
        onClick={() => termRef.current?.focus()}
        className="h-[64vh] cursor-text p-2"
        style={{ background: "#16191e" }}
      />
    </div>
  );
}

/* ---- Metrics (live rolling graphs) --------------------------------------- */

function MetricsPanel({ vmid }: { vmid: number }) {
  const { data: containers } = usePoll<{ containers: { vmid: number; cpu: number; maxcpu: number; mem: number; maxmem: number; status: string }[] }>("/api/containers", 4000);
  const { data: metrics } = usePoll<{ instances: { vmid: number; online: number; max: number; reachable: boolean }[] }>("/api/metrics", 4000);

  const c = containers?.containers.find((x) => x.vmid === vmid);
  const m = metrics?.instances.find((x) => x.vmid === vmid);
  const cpu = c && c.maxcpu ? (c.cpu / 1) * 100 : 0; // cpu is already 0..1 fraction of total
  const memPct = c && c.maxmem ? (c.mem / c.maxmem) * 100 : 0;
  const players = m?.online ?? 0;

  // Rolling client-side history (live monitor; resets on reload).
  const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; players: number[] }>({ cpu: [], mem: [], players: [] });
  const lastKey = useRef("");
  useEffect(() => {
    if (!c) return;
    const key = `${c.cpu}|${c.mem}|${players}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setHist((h) => ({
      cpu: [...h.cpu, Math.round(cpu)].slice(-60),
      mem: [...h.mem, Math.round(memPct)].slice(-60),
      players: [...h.players, players].slice(-60),
    }));
  }, [c, cpu, memPct, players]);

  const cards: { label: string; value: string; series: number[]; color: string; max?: number }[] = [
    { label: "CPU", value: `${Math.round(cpu)}%`, series: hist.cpu, color: "#7c83ff", max: 100 },
    { label: "Memory", value: c ? `${bytes(c.mem)} / ${bytes(c.maxmem)}` : "—", series: hist.mem, color: "#38bdf8", max: 100 },
    { label: "Players", value: `${players}${m ? ` / ${m.max}` : ""}`, series: hist.players, color: "#34d399" },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {cards.map((card) => (
        <div key={card.label} className="panel p-4">
          <div className="flex items-center justify-between">
            <span className="eyebrow">{card.label}</span>
            <span className="text-base font-semibold tabular-nums">{card.value}</span>
          </div>
          <div className="mt-3">
            {card.series.length < 2 ? (
              <div className="flex h-12 items-center text-xs text-muted-foreground/60">Collecting…</div>
            ) : (
              <Sparkline data={card.series} color={card.color} max={card.max} height={48} label={card.label} />
            )}
          </div>
        </div>
      ))}
      <p className="sm:col-span-3 text-[11px] text-muted-foreground/60">Live rolling metrics (last ~60 samples). CPU/RAM from Proxmox, players via Minecraft SLP.</p>
    </div>
  );
}

/* ---- Files --------------------------------------------------------------- */

function FilesPanel({ vmid, roots }: { vmid: number; roots: { label: string; path: string }[] }) {
  const defaultRoot = roots[0]?.path ?? "/opt/mc";
  const [path, setPath] = useState(defaultRoot);
  const { data, error, loading } = usePoll<{ path: string; entries: FileEntry[] }>(
    `/api/services/${vmid}/files?path=${encodeURIComponent(path)}`,
    8000,
  );
  const [viewing, setViewing] = useState<string | null>(null);

  const segments = path.replace(/^\//, "").split("/");
  const parent = path === defaultRoot ? null : path.slice(0, path.lastIndexOf("/")) || "/";

  function crumbPath(idx: number): string {
    return "/" + segments.slice(0, idx + 1).join("/");
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-panel">
      {/* Root picker — only shown when multiple roots exist (e.g. Hytale) */}
      {roots.length > 1 && (
        <div className="flex gap-1 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2">
          {roots.map((r) => (
            <button
              key={r.path}
              onClick={() => setPath(r.path)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                path === r.path || path.startsWith(r.path + "/")
                  ? "bg-sky-500/15 text-sky-300"
                  : "text-white/35 hover:bg-white/[0.05] hover:text-white/60"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {/* Breadcrumb bar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
        <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400/60" />
        {segments.map((seg, i) => {
          const p = crumbPath(i);
          const navigable = roots.some((r) => p === r.path || p.startsWith(r.path + "/"));
          return (
            <span key={p} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-white/20" />}
              <button
                className="rounded px-1 py-0.5 font-mono text-xs transition-colors hover:bg-white/[0.06] hover:text-white/70 disabled:text-white/25 disabled:hover:bg-transparent"
                disabled={!navigable || p === path}
                onClick={() => setPath(p)}
              >
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-red-400">Could not list: {error}</div>
      )}

      <div>
        {parent && (
          <button
            className="flex w-full items-center gap-2 border-b border-white/[0.04] px-4 py-2 text-left text-sm transition-colors hover:bg-white/[0.03]"
            onClick={() => setPath(parent)}
          >
            <CornerLeftUp className="h-4 w-4 text-white/25" />
            <span className="font-mono text-xs text-white/30">..</span>
          </button>
        )}
        {(data?.entries ?? []).map((e) => {
          const full = `${path === "/" ? "" : path}/${e.name}`;
          const isDir = e.type === "dir";
          return (
            <button
              key={e.name}
              className="flex w-full items-center gap-3 border-b border-white/[0.03] px-4 py-2 text-left text-sm last:border-b-0 transition-colors hover:bg-white/[0.03]"
              onClick={() => (isDir ? setPath(full) : setViewing(full))}
            >
              {isDir ? (
                <Folder className="h-4 w-4 shrink-0 text-sky-400/70" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-white/25" />
              )}
              <span className="flex-1 truncate font-mono text-sm text-white/70">{e.name}</span>
              {e.type === "link" && (
                <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] text-white/40">
                  link
                </span>
              )}
              {!isDir && (
                <span className="font-mono text-[11px] text-white/25">{bytes(e.size)}</span>
              )}
            </button>
          );
        })}
        {!loading && (data?.entries?.length ?? 0) === 0 && !parent && (
          <div className="px-4 py-10 text-center text-sm text-white/25">Empty directory.</div>
        )}
      </div>

      {viewing && (
        <FileViewer vmid={vmid} path={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

function FileViewer({
  vmid,
  path,
  onClose,
}: {
  vmid: number;
  path: string;
  onClose: () => void;
}) {
  const { data, error, loading } = usePoll<{
    content: string;
    truncated: boolean;
    size: number;
  }>(`/api/services/${vmid}/files?path=${encodeURIComponent(path)}&file=1`, 600_000);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.content != null && !editing) setDraft(data.content);
  }, [data?.content, editing]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/services/${vmid}/files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: draft }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success("File saved");
      setEditing(false);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const editable = !data?.truncated;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogTitle className="font-mono text-sm break-all leading-relaxed text-white/80">
              {path}
            </DialogTitle>
            <div className="flex shrink-0 items-center gap-1">
              {editable && !editing && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => { setDraft(data?.content ?? ""); setEditing(true); }}
                >
                  <Pencil className="h-3 w-3" /> Edit
                </Button>
              )}
              {editing && (
                <>
                  <Button size="sm" className="h-7 text-xs" onClick={save} disabled={saving}>
                    <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)}>
                    <X className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogHeader>
        {(error || saveError) && (
          <div className="text-sm text-red-400">{error ?? saveError}</div>
        )}
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-[60vh] w-full resize-none rounded-lg bg-[#070b07] p-3 font-mono text-xs text-emerald-200/90 outline-none focus:ring-1 focus:ring-emerald-600/40"
          />
        ) : (
          <pre className="max-h-[65vh] overflow-auto rounded-lg bg-[#070b07] p-3 font-mono text-xs whitespace-pre-wrap text-emerald-200/60">
            {loading ? "Loading…" : data?.content || "(empty)"}
          </pre>
        )}
        {data?.truncated && (
          <p className="text-xs text-amber-300">
            File is {bytes(data.size)} — showing first 256 KB. Editing disabled for large files.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
