"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { HELP_TOPICS, HELP_BY_ID } from "@/lib/help-content";
import { cn } from "@/lib/utils";
import { HelpCircle, Search } from "lucide-react";

type HelpCtx = { open: (topicId?: string) => void };
const Ctx = createContext<HelpCtx | null>(null);

/** Open the help center (optionally jumping to a topic). Safe no-op outside the provider. */
export function useHelp(): HelpCtx {
  return useContext(Ctx) ?? { open: () => {} };
}

/**
 * Global help center. Provides useHelp().open(topicId) and renders a right-side wiki panel with
 * every topic grouped by category. Opening with a topic id scrolls to + highlights that section.
 */
export function HelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const refs = useRef<Map<string, HTMLDivElement>>(new Map());

  const openHelp = useCallback((topicId?: string) => {
    setActive(topicId ?? null);
    setQ("");
    setOpen(true);
  }, []);

  // On open with a topic, scroll it into view + pulse-highlight.
  useEffect(() => {
    if (!open || !active) return;
    const el = refs.current.get(active);
    if (!el) return;
    const t = setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("help-hl");
      setTimeout(() => el.classList.remove("help-hl"), 1600);
    }, 80);
    return () => clearTimeout(t);
  }, [open, active]);

  const categories = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? HELP_TOPICS.filter((t) => t.title.toLowerCase().includes(needle) || t.category.toLowerCase().includes(needle))
      : HELP_TOPICS;
    const map = new Map<string, typeof HELP_TOPICS>();
    for (const t of filtered) { const a = map.get(t.category) ?? []; a.push(t); map.set(t.category, a); }
    return [...map.entries()];
  }, [q]);

  return (
    <Ctx.Provider value={{ open: openHelp }}>
      {children}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b border-hairline px-4 py-3">
            <SheetTitle className="flex items-center gap-2 text-sm"><HelpCircle className="h-4 w-4 text-brand" /> Help center</SheetTitle>
          </SheetHeader>
          <div className="border-b border-hairline px-4 py-2">
            <div className="flex items-center gap-2 rounded-md border border-hairline bg-accent/30 px-2.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground/60" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help…"
                className="w-full bg-transparent py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/50" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {categories.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No topics match.</p>}
            {categories.map(([cat, topics]) => (
              <div key={cat} className="mb-5">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">{cat}</div>
                <div className="space-y-2.5">
                  {topics.map((t) => (
                    <div key={t.id} ref={(el) => { if (el) refs.current.set(t.id, el); else refs.current.delete(t.id); }}
                      className="rounded-md border border-hairline bg-panel/60 p-3 transition-colors">
                      <div className="mb-1 text-[13px] font-semibold">{t.title}</div>
                      <div className="space-y-1.5 text-[12px] leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground [&_code]:rounded [&_code]:bg-accent [&_code]:px-1 [&_code]:text-[11px] [&_code]:text-foreground">{t.body}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </Ctx.Provider>
  );
}

/** Tiny inline "?" beside a setting; click opens the help center jumped to `topic`. */
export function HelpButton({ topic, className }: { topic: string; className?: string }) {
  const { open } = useHelp();
  const known = HELP_BY_ID.has(topic);
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(topic); }}
      aria-label="Help"
      title={known ? "What's this?" : "Help"}
      className={cn("inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:text-brand", className)}
    >
      <HelpCircle className="h-3.5 w-3.5" />
    </button>
  );
}
