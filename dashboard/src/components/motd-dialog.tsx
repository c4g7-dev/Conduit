"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MessageSquare, Server } from "lucide-react";

// Minecraft legacy colour + format codes.
const COLORS: Record<string, string> = {
  "0": "#000000", "1": "#0000AA", "2": "#00AA00", "3": "#00AAAA",
  "4": "#AA0000", "5": "#AA00AA", "6": "#FFAA00", "7": "#AAAAAA",
  "8": "#555555", "9": "#5555FF", a: "#55FF55", b: "#55FFFF",
  c: "#FF5555", d: "#FF55FF", e: "#FFFF55", f: "#FFFFFF",
};
const SWATCHES = "0123456789abcdef".split("");

type Span = { text: string; color: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean };

/** Parse a MOTD line (with & or § codes) into styled spans for preview. */
function parseLine(line: string): Span[] {
  const spans: Span[] = [];
  let color = "#AAAAAA"; // MC default MOTD grey
  let bold = false, italic = false, underline = false, strike = false;
  let buf = "";
  const flush = () => { if (buf) { spans.push({ text: buf, color, bold, italic, underline, strike }); buf = ""; } };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if ((c === "&" || c === "§") && i + 1 < line.length) {
      const code = line[++i].toLowerCase();
      if (COLORS[code]) { flush(); color = COLORS[code]; bold = italic = underline = strike = false; }
      else if (code === "l") { flush(); bold = true; }
      else if (code === "o") { flush(); italic = true; }
      else if (code === "n") { flush(); underline = true; }
      else if (code === "m") { flush(); strike = true; }
      else if (code === "r") { flush(); color = "#AAAAAA"; bold = italic = underline = strike = false; }
      else buf += c + line[i];
    } else buf += c;
  }
  flush();
  return spans;
}

export function MotdPreview({ motd, name, players, max }: { motd: string; name: string; players: number; max: number }) {
  const lines = (motd || "").split("\n").slice(0, 2);
  while (lines.length < 2) lines.push("");
  return (
    <div className="rounded-md border border-black/40 bg-[#2c2c2c] p-2 font-[system-ui]" style={{ imageRendering: "pixelated" }}>
      <div className="flex gap-2">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-sm bg-gradient-to-br from-orange-500 to-amber-600 text-white">
          <Server className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between">
            <span className="truncate text-sm font-medium text-white">{name}</span>
            <span className="ml-2 flex shrink-0 items-center gap-1 text-xs">
              <span className="text-[#AAAAAA] tabular-nums">{players}/{max}</span>
              <span className="text-[#55FF55]">▮▮▮▮▮</span>
            </span>
          </div>
          {lines.map((ln, i) => (
            <div key={i} className="truncate text-xs leading-tight" style={{ fontFamily: "monospace" }}>
              {parseLine(ln).map((s, j) => (
                <span key={j} style={{
                  color: s.color,
                  fontWeight: s.bold ? 700 : 400,
                  fontStyle: s.italic ? "italic" : "normal",
                  textDecoration: [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || "none",
                }}>{s.text || " "}</span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MotdDialog({
  taskId, taskName, current, players, max, onSaved,
}: {
  taskId: string; taskName: string; current: string; players: number; max: number; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [motd, setMotd] = useState(current || `Conduit &b${taskName}\n&7Powered by Proxmox`);
  const [busy, setBusy] = useState(false);

  function insert(code: string) {
    setMotd((m) => m + `&${code}`);
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/motd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motd }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`MOTD applied to ${json.applied}/${json.instances} instance(s)`);
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <MessageSquare className="h-4 w-4" /> MOTD
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit MOTD · {taskName}</DialogTitle>
          <DialogDescription>
            The message shown in the server list. Use <code>&amp;</code> colour codes; live
            preview below. Applies to every running instance of this task immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* live preview */}
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Live preview</div>
            <MotdPreview motd={motd} name={taskName} players={players} max={max} />
          </div>

          {/* colour palette */}
          <div className="flex flex-wrap gap-1">
            {SWATCHES.map((c) => (
              <button key={c} type="button" onClick={() => insert(c)} title={`&${c}`}
                className="h-6 w-6 rounded border border-black/30" style={{ backgroundColor: COLORS[c] }} />
            ))}
            {["l", "o", "n", "m", "r"].map((c) => (
              <button key={c} type="button" onClick={() => insert(c)} title={`&${c}`}
                className="h-6 rounded border border-border px-1.5 text-[10px] uppercase text-muted-foreground hover:bg-accent">
                {c === "l" ? "B" : c === "o" ? "I" : c === "n" ? "U" : c === "m" ? "S" : "R"}
              </button>
            ))}
          </div>

          <textarea
            value={motd}
            onChange={(e) => setMotd(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="&aWelcome!&r\n&7line two"
          />
          <p className="text-[11px] text-muted-foreground">Two lines max. Use a newline for the second line.</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Applying…" : "Apply MOTD"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
