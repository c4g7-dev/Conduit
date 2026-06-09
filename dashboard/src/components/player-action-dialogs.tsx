"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Send, MoveRight, UserX, Loader2, Server } from "lucide-react";

/* ---- Minecraft &-code styling (shared by the message composer + preview) --------------- */

const MC_COLORS: Record<string, string> = {
  "0": "#000000", "1": "#0000AA", "2": "#00AA00", "3": "#00AAAA", "4": "#AA0000",
  "5": "#AA00AA", "6": "#FFAA00", "7": "#AAAAAA", "8": "#555555", "9": "#5555FF",
  a: "#55FF55", b: "#55FFFF", c: "#FF5555", d: "#FF55FF", e: "#FFFF55", f: "#FFFFFF",
};
// Format codes offered per platform. MC = full legacy set; Hytale = its native model
// (colour + bold + italic + monospace, no underline/strike/obfuscate). `&p` = monospace (Hytale).
const MC_FORMATS = [
  { code: "l", label: "Bold" }, { code: "o", label: "Italic" }, { code: "n", label: "Underline" },
  { code: "m", label: "Strike" }, { code: "r", label: "Reset" },
];
const HYTALE_FORMATS = [
  { code: "l", label: "Bold" }, { code: "o", label: "Italic" }, { code: "p", label: "Mono" }, { code: "r", label: "Reset" },
];

type Run = { text: string; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; mono?: boolean };
function parseLegacy(s: string): Run[] {
  const runs: Run[] = [];
  let cur: Run = { text: "" };
  const push = () => { if (cur.text) runs.push(cur); };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === "&" || c === "§") && i + 1 < s.length) {
      const code = s[i + 1].toLowerCase();
      if (MC_COLORS[code]) { push(); cur = { text: "", color: MC_COLORS[code] }; i++; continue; } // colour resets format
      if (code === "l") { push(); cur = { ...cur, text: "", bold: true }; i++; continue; }
      if (code === "o") { push(); cur = { ...cur, text: "", italic: true }; i++; continue; }
      if (code === "n") { push(); cur = { ...cur, text: "", underline: true }; i++; continue; }
      if (code === "m") { push(); cur = { ...cur, text: "", strike: true }; i++; continue; }
      if (code === "p") { push(); cur = { ...cur, text: "", mono: true }; i++; continue; }
      if (code === "r") { push(); cur = { text: "" }; i++; continue; }
    }
    cur.text += c;
  }
  push();
  return runs.length ? runs : [{ text: "" }];
}

function Preview({ value }: { value: string }) {
  const runs = parseLegacy(value);
  return (
    <div className="min-h-[2.25rem] rounded-md border border-hairline bg-[#1a1a1a] px-3 py-2 font-mono text-[13px] leading-relaxed">
      {value.trim() === "" ? <span className="text-muted-foreground/40">preview…</span> : runs.map((r, i) => (
        <span key={i} style={{
          color: r.color ?? "#FFFFFF",
          fontWeight: r.bold ? 700 : 400,
          fontStyle: r.italic ? "italic" : "normal",
          fontFamily: r.mono ? "ui-monospace, monospace" : undefined,
          textDecoration: [r.underline && "underline", r.strike && "line-through"].filter(Boolean).join(" ") || "none",
        }}>{r.text}</span>
      ))}
    </div>
  );
}

/* ---- message composer (styled, with live preview) ------------------------------------- */

export function MessageDialog({ open, onOpenChange, target, platform, onSend }: {
  open: boolean; onOpenChange: (o: boolean) => void; target: string;
  platform: "minecraft" | "hytale";
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) setText(""); }, [open]);
  const formats = platform === "hytale" ? HYTALE_FORMATS : MC_FORMATS;
  const hint = platform === "hytale"
    ? "Hytale-native styling — colour, bold, italic, mono. Rendered with Hytale's own formatting."
    : "Minecraft & colour/format codes, rendered styled in chat.";

  function insert(code: string) {
    const el = ref.current;
    const ins = "&" + code;
    if (!el) { setText((t) => t + ins); return; }
    const a = el.selectionStart ?? text.length, b = el.selectionEnd ?? text.length;
    const next = text.slice(0, a) + ins + text.slice(b);
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = a + ins.length; });
  }
  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    try { await onSend(text); onOpenChange(false); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Message {target} <span className="ml-1 text-[11px] font-normal uppercase tracking-wide text-muted-foreground/60">{platform}</span></DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-[12px] text-muted-foreground">{hint}</p>
          {/* colour swatches */}
          <div className="flex flex-wrap gap-1">
            {Object.entries(MC_COLORS).map(([code, hex]) => (
              <button key={code} title={`&${code}`} onClick={() => insert(code)}
                className="h-6 w-6 rounded border border-white/10 transition-transform hover:scale-110"
                style={{ background: hex }} />
            ))}
            {formats.map((f) => (
              <button key={f.code} title={`&${f.code} — ${f.label}`} onClick={() => insert(f.code)}
                className="h-6 rounded border border-hairline bg-accent/40 px-2 text-[11px] font-medium hover:bg-accent">
                &{f.code}
              </button>
            ))}
          </div>
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
            rows={3} placeholder="Type a message… use & colour codes"
            className="w-full resize-none rounded-md border border-hairline bg-accent/30 px-3 py-2 font-mono text-[13px] outline-none placeholder:text-muted-foreground/50" />
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">Preview</div>
            <Preview value={text} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="rounded-md px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground">Cancel</button>
            <button onClick={send} disabled={busy || !text.trim()}
              className="flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---- move (compatible-service picker) ------------------------------------------------- */

type MoveTarget = { vmid: number; task: string; label: string; node: string; online: number; max: number; target: string };

export function MoveDialog({ open, onOpenChange, player, kindLabel, onMove }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  player: { name: string; server: string; vmid: number; group?: string };
  kindLabel: string;
  onMove: (target: string) => Promise<void>;
}) {
  const [targets, setTargets] = useState<MoveTarget[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setTargets(null); return; }
    const q = new URLSearchParams({ server: player.server, vmid: String(player.vmid) });
    if (player.group) q.set("group", player.group);
    fetch(`/api/connector/move-targets?${q}`).then((r) => r.json())
      .then((j) => setTargets(j.targets ?? []))
      .catch(() => setTargets([]));
  }, [open, player.server, player.vmid, player.group]);

  async function pick(t: MoveTarget) {
    setBusy(t.target);
    try { await onMove(t.target); onOpenChange(false); } finally { setBusy(null); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Move {player.name}</DialogTitle></DialogHeader>
        <p className="mb-2 text-[12px] text-muted-foreground">
          Compatible {kindLabel} services (same type — proxies excluded).
        </p>
        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {targets === null && <div className="py-6 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></div>}
          {targets?.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">No compatible services to move to.</div>}
          {targets?.map((t) => (
            <button key={t.target} disabled={!!busy} onClick={() => pick(t)}
              className="flex w-full items-center justify-between rounded-md border border-hairline px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent/50 disabled:opacity-50">
              <span className="flex items-center gap-2">
                <Server className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{t.label}</span>
                <span className="text-[11px] text-muted-foreground/60">{t.node}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-[11px] tabular-nums text-emerald-400">{t.online}/{t.max}</span>
                {busy === t.target ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoveRight className="h-3.5 w-3.5 text-muted-foreground" />}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---- kick (reason) -------------------------------------------------------------------- */

export function KickDialog({ open, onOpenChange, target, onKick }: {
  open: boolean; onOpenChange: (o: boolean) => void; target: string;
  onKick: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setReason(""); }, [open]);
  async function kick() {
    setBusy(true);
    try { await onKick(reason.trim()); onOpenChange(false); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Kick {target}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") kick(); }}
            placeholder="Reason (optional)"
            className="w-full rounded-md border border-hairline bg-accent/30 px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground/50" />
          <div className="flex justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="rounded-md px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground">Cancel</button>
            <button onClick={kick} disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserX className="h-3.5 w-3.5" />} Kick
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
