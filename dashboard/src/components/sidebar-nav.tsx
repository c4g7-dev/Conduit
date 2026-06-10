"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  LayoutDashboard,
  Boxes,
  LayoutTemplate,
  Server,
  Archive,
  Cable,
  ChevronDown,
  SlidersHorizontal,
  ServerCog,
  Code2,
  Users,
  Activity,
  CalendarClock,
  FolderTree,
  Menu,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
type NavSection = { id: string; label: string; items: NavItem[] };

const sections: NavSection[] = [
  {
    id: "orchestration",
    label: "Orchestration",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/groups", label: "Servers", icon: ServerCog },
      { href: "/players", label: "Players", icon: Users },
      { href: "/activity", label: "Activity", icon: Activity },
      { href: "/schedules", label: "Schedules", icon: CalendarClock },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    items: [
      { href: "/containers", label: "Containers", icon: Boxes },
      { href: "/templates", label: "Templates", icon: LayoutTemplate },
      { href: "/files", label: "Files", icon: FolderTree },
      { href: "/backups", label: "Backups", icon: Archive },
    ],
  },
  {
    id: "developer",
    label: "Developer",
    items: [{ href: "/apis", label: "API", icon: Code2 }],
  },
  {
    id: "settings",
    label: "Settings",
    items: [{ href: "/settings", label: "Settings", icon: SlidersHorizontal }],
  },
];

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b border-hairline px-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/15 ring-1 ring-brand/30">
        <Cable className="h-4 w-4 text-brand" />
      </div>
      <div className="leading-tight">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-foreground">
          Conduit
          <span className="flex items-center gap-1 rounded-sm bg-emerald-500/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-emerald-400">
            <span className="h-1 w-1 rounded-full bg-emerald-400" />
            live
          </span>
        </div>
        <div className="text-[10.5px] text-muted-foreground">c4g7 network</div>
      </div>
    </div>
  );
}

function ClusterFooter() {
  return (
    <div className="border-t border-hairline p-2.5">
      <div className="flex items-center gap-2.5 rounded-md border border-hairline bg-panel px-2.5 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent">
          <Server className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-xs font-medium text-foreground">conduit cluster</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            VIP 10.27.27.50
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shared nav body (used by the desktop sidebar + the mobile drawer). `onNavigate` closes the drawer. */
function NavSections({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="flex-1 overflow-y-auto px-2 py-3">
      {sections.map((section) => {
        const isCollapsed = collapsed[section.id];
        return (
          <div key={section.id} className="mb-1">
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [section.id]: !c[section.id] }))}
              className="group flex w-full items-center gap-1 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
            >
              <ChevronDown className={cn("h-3 w-3 transition-transform duration-150", isCollapsed && "-rotate-90")} />
              {section.label}
            </button>
            {!isCollapsed && (
              <div className="mt-0.5 space-y-px">
                {section.items.map(({ href, label, icon: Icon }) => {
                  const active = isActive(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={onNavigate}
                      className={cn(
                        "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors",
                        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      {active && <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-brand" />}
                      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-brand" : "text-muted-foreground")} />
                      <span>{label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function SidebarNav() {
  const path = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setMobileOpen(false); }, [path]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-hairline bg-sidebar md:flex">
        <Brand />
        <NavSections />
        <ClusterFooter />
      </aside>

      {/* Mobile top bar (with hamburger) */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-hairline bg-sidebar/95 px-3 backdrop-blur md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-hairline text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand/15 ring-1 ring-brand/30">
            <Cable className="h-4 w-4 text-brand" />
          </div>
          <span className="text-[13px] font-semibold tracking-tight">Conduit</span>
        </div>
      </header>

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="flex w-[17rem] flex-col gap-0 p-0">
          <Brand />
          <NavSections onNavigate={() => setMobileOpen(false)} />
          <ClusterFooter />
        </SheetContent>
      </Sheet>
    </>
  );
}
