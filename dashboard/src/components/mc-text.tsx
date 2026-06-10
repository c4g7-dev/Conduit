"use client";

/**
 * Minecraft legacy-text renderer: parses `&`/`§` color + style codes into styled spans,
 * the way they'd appear in chat. Used for prefix/suffix previews in the permissions
 * editor (and anywhere else a chat-accurate preview is needed).
 */
const COLORS: Record<string, string> = {
  "0": "#000000", "1": "#0000AA", "2": "#00AA00", "3": "#00AAAA",
  "4": "#AA0000", "5": "#AA00AA", "6": "#FFAA00", "7": "#AAAAAA",
  "8": "#555555", "9": "#5555FF", a: "#55FF55", b: "#55FFFF",
  c: "#FF5555", d: "#FF55FF", e: "#FFFF55", f: "#FFFFFF",
};

type Span = { text: string; color: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean };

export function parseMcText(line: string, defaultColor = "#FFFFFF"): Span[] {
  const spans: Span[] = [];
  let color = defaultColor;
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
      else if (code === "r") { flush(); color = defaultColor; bold = italic = underline = strike = false; }
      else buf += c + line[i];
    } else buf += c;
  }
  flush();
  return spans;
}

/** Inline chat-style preview of a legacy-coded string (dark chat backdrop supplied by caller). */
export function McText({ text, defaultColor = "#FFFFFF", className }: { text: string; defaultColor?: string; className?: string }) {
  const spans = parseMcText(text, defaultColor);
  return (
    <span className={className} style={{ fontFamily: "Menlo, monospace" }}>
      {spans.length === 0 ? <span className="opacity-40">…</span> : spans.map((s, i) => (
        <span
          key={i}
          style={{
            color: s.color,
            fontWeight: s.bold ? 700 : 400,
            fontStyle: s.italic ? "italic" : "normal",
            textDecoration: [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || "none",
            textShadow: "1px 1px 0 rgba(0,0,0,.45)",
          }}
        >
          {s.text}
        </span>
      ))}
    </span>
  );
}
