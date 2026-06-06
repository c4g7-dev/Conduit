"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Boxes,
  LayoutTemplate,
  Workflow,
  Cable,
  Server,
} from "lucide-react";

const nav = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/containers", label: "Containers", icon: Boxes },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/groups", label: "Groups & Tasks", icon: Workflow },
];

export function SidebarNav() {
  const path = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-border/60 bg-card/40 backdrop-blur md:flex">
      <div className="flex h-16 items-center gap-2.5 border-b border-border/60 px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-sm">
          <Cable className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">Conduit</div>
          <div className="text-[11px] text-muted-foreground">c4g7 network</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border/60 p-3">
        <div className="flex items-center gap-2.5 rounded-md bg-muted/40 px-3 py-2.5">
          <Server className="h-4 w-4 text-muted-foreground" />
          <div className="leading-tight">
            <div className="text-xs font-medium">skdCore01</div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              10.27.27.126
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
