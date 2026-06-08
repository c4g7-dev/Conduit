"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  cloneElement,
  isValidElement,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Lightweight right-click context menu. Same component API as a typical
 * dropdown/context-menu primitive, but a self-contained implementation — base-ui's
 * ContextMenu can't render onto a `<tr>` trigger (needed for table rows), so we roll
 * our own controlled, cursor-positioned, portal-rendered menu that works on any element.
 */

type Pos = { x: number; y: number };
type Ctx = { open: boolean; pos: Pos; setOpen: (o: boolean) => void; openAt: (p: Pos) => void };
const ContextMenuCtx = createContext<Ctx | null>(null);

function ContextMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos>({ x: 0, y: 0 });
  return (
    <ContextMenuCtx.Provider value={{ open, pos, setOpen, openAt: (p) => { setPos(p); setOpen(true); } }}>
      {children}
    </ContextMenuCtx.Provider>
  );
}

function ContextMenuTrigger({
  render,
  children,
}: {
  // The element to render as the trigger container (e.g. a <tr> or <button>).
  render: React.ReactElement;
  children?: React.ReactNode;
}) {
  const ctx = useContext(ContextMenuCtx)!;
  if (!isValidElement(render)) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = render as React.ReactElement<any>;
  return cloneElement(
    el,
    {
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation(); // don't also trigger a parent (nested) context menu
        ctx.openAt({ x: e.clientX, y: e.clientY });
        el.props.onContextMenu?.(e);
      },
    },
    children ?? el.props.children,
  );
}

function ContextMenuContent({ className, children }: { className?: string; children: React.ReactNode }) {
  const ctx = useContext(ContextMenuCtx)!;
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!ctx.open) return;
    const close = () => ctx.setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    // close on any outside click/scroll/resize
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("mousedown", onDown);
    };
  }, [ctx]);

  if (!mounted || !ctx.open) return null;

  // Keep the menu within the viewport.
  const MENU_W = 200, MENU_H = 320;
  const x = Math.min(ctx.pos.x, window.innerWidth - MENU_W - 8);
  const y = Math.min(ctx.pos.y, window.innerHeight - MENU_H - 8);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", top: y, left: x, zIndex: 50 }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "min-w-44 origin-top-left animate-in fade-in-0 zoom-in-95 overflow-hidden rounded-md border border-hairline bg-popover p-1 text-popover-foreground shadow-lg duration-100",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

function ContextMenuItem({
  className,
  variant = "default",
  onClick,
  disabled,
  children,
}: {
  className?: string;
  variant?: "default" | "destructive";
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const ctx = useContext(ContextMenuCtx)!;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      data-variant={variant}
      onClick={() => { ctx.setOpen(false); onClick?.(); }}
      className={cn(
        "flex w-full cursor-default select-none items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[variant=destructive]:text-destructive data-[variant=destructive]:hover:bg-destructive/15 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
    >
      {children}
    </button>
  );
}

function ContextMenuLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("truncate px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </div>
  );
}

function ContextMenuSeparator({ className }: { className?: string }) {
  return <div className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
};
