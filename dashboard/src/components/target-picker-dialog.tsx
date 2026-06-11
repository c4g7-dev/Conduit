"use client";

/**
 * Shared target picker — a collapsible checkbox tree mirroring the Servers rail
 * (group → subgroups (nested) → services → instances). Selecting a parent visibly covers
 * everything beneath it: descendants render checked (muted, non-clickable) without becoming
 * explicit targets — the parent alone covers them, so later scale-ups are included.
 *
 * Used by the Schedules target chooser and the global-template member chooser; behaviour
 * is tuned via `allowInstances` (offer per-instance rows — STATIC services only; dynamic ones
 * are whole-service since their instances churn) and `taskFilter` (e.g. backups
 * exclude dynamic services — they're recreated on every scale cycle).
 */
import { useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RoleDot } from "@/components/role-dot";
import { cn } from "@/lib/utils";
import { Boxes, CornerDownRight, Server, Crosshair, ChevronDown } from "lucide-react";

export type PickTarget =
  | { type: "group"; id: string }
  | { type: "subgroup"; groupId: string; id: string }
  | { type: "task"; id: string }
  | { type: "instance"; vmid: number };

export type PickInstance = { vmid: number; name: string; status: string };
export type PickTask = { id: string; name: string; role: string; mode?: "dynamic" | "static"; subgroupId?: string; instances: PickInstance[] };
export type PickSubgroup = { id: string; name: string; parentId?: string };
export type PickGroup = { id: string; name: string; subgroups?: PickSubgroup[]; tasks: PickTask[] };

/** Stable string key for a target (checkbox state + display lookups). */
export const targetKey = (t: PickTarget): string =>
  t.type === "group" ? `g:${t.id}` :
  t.type === "subgroup" ? `sg:${t.groupId}:${t.id}` :
  t.type === "task" ? `t:${t.id}` : `i:${t.vmid}`;

/** Expand a selection to concrete task ids (group/subgroup → member tasks). For consumers
 *  that store flat task lists (e.g. global-template membership). */
export function expandToTaskIds(groups: PickGroup[], sel: Map<string, PickTarget>): string[] {
  const out = new Set<string>();
  for (const t of sel.values()) {
    if (t.type === "task") out.add(t.id);
    else if (t.type === "group") {
      for (const g of groups) if (g.id === t.id) for (const task of g.tasks) out.add(task.id);
    } else if (t.type === "subgroup") {
      const g = groups.find((x) => x.id === t.groupId);
      if (!g) continue;
      const sgs = g.subgroups ?? [];
      const inChain = (sgId: string | undefined) => {
        let cur = sgId;
        for (let i = 0; cur && i < 50; i++) {
          if (cur === t.id) return true;
          cur = sgs.find((s) => s.id === cur)?.parentId;
        }
        return false;
      };
      for (const task of g.tasks) if (inChain(task.subgroupId)) out.add(task.id);
    } else if (t.type === "instance") {
      // map an instance pick back to its owning service (task-level consumers like routing/LP)
      for (const g of groups) for (const task of g.tasks) if (task.instances.some((i) => i.vmid === t.vmid)) out.add(task.id);
    }
  }
  return [...out];
}

export function TargetPickerDialog({
  groups, picked, onClose, onSave,
  title = "Choose targets",
  description = "Any mix of groups, subgroups, services and single instances — selecting a parent includes everything inside it.",
  allowInstances = true,
  taskFilter,
  filterNote,
}: {
  groups: PickGroup[];
  picked: Map<string, PickTarget>;
  onClose: () => void;
  onSave: (picked: Map<string, PickTarget>) => void;
  title?: string;
  description?: string;
  /** offer per-instance rows under multi-instance services */
  allowInstances?: boolean;
  /** services failing this predicate are hidden (e.g. only static ones for backups) */
  taskFilter?: (t: PickTask) => boolean;
  /** short hint shown when taskFilter hides services (explains why something is missing) */
  filterNote?: string;
}) {
  const [sel, setSel] = useState<Map<string, PickTarget>>(new Map(picked));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const c: Record<string, boolean> = {};
    for (const g of groups) for (const t of g.tasks) if (t.instances.length > 1) c[`t:${t.id}`] = true;
    return c;
  });
  const flipCollapse = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  const flip = (t: PickTarget) => setSel((prev) => {
    const next = new Map(prev);
    const k = targetKey(t);
    if (next.has(k)) next.delete(k); else next.set(k, t);
    return next;
  });

  const anyFiltered = !!taskFilter && groups.some((g) => g.tasks.some((t) => !taskFilter(t)));

  const Row = ({ t, depth, icon, label, sub, covered, chevron }: {
    t: PickTarget; depth: number; icon: React.ReactNode; label: React.ReactNode; sub?: string;
    covered?: boolean; chevron?: string;
  }) => {
    const k = targetKey(t);
    const explicit = sel.has(k);
    const on = explicit || !!covered;
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-2 py-2 text-left text-[13px] transition-colors",
          explicit ? "border-brand/40 bg-brand/10" : covered ? "border-brand/20 bg-brand/[0.04] opacity-70" : "border-hairline hover:bg-accent/50",
        )}
        style={{ marginLeft: depth * 16, width: `calc(100% - ${depth * 16}px)` }}
      >
        {chevron ? (
          <button onClick={() => flipCollapse(chevron)} className="rounded p-0.5 text-muted-foreground hover:bg-accent" title={collapsed[chevron] ? "Expand" : "Collapse"}>
            <ChevronDown className={cn("h-3 w-3 transition-transform", collapsed[chevron] && "-rotate-90")} />
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          onClick={() => { if (!covered) flip(t); }}
          disabled={!!covered}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
          title={covered ? "Included via the selected parent" : undefined}
        >
          <input type="checkbox" readOnly checked={on} className="pointer-events-none h-3.5 w-3.5 accent-[var(--brand,#7c83ff)]" />
          {icon}
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          {covered && !explicit && <span className="shrink-0 text-[10px] text-muted-foreground/60">via parent</span>}
          {sub && <span className="shrink-0 text-[11px] text-muted-foreground/60">{sub}</span>}
        </button>
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Crosshair className="h-4 w-4 text-brand" /> {title}</DialogTitle>
          <DialogDescription>{description}{anyFiltered && filterNote ? ` ${filterNote}` : ""}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto pr-1">
          {groups.map((g) => {
            const gKey = `g:${g.id}`;
            const gSel = sel.has(gKey);
            const sgs = g.subgroups ?? [];
            const visTasks = g.tasks.filter((t) => !taskFilter || taskFilter(t));
            const loose = visTasks.filter((t) => !t.subgroupId || !sgs.some((s) => s.id === t.subgroupId));

            const renderTask = (t: PickTask, depth: number, covered: boolean) => {
              const tKey = `t:${t.id}`;
              const tOn = sel.has(tKey) || covered;
              // Per-instance rows only for STATIC/persistent services — a dynamic service's
              // instances churn (scale up/down, fresh vmids), so it's selectable only as a whole.
              const expandable = allowInstances && t.mode !== "dynamic" && t.instances.length > 1;
              return (
                <div key={t.id} className="space-y-1">
                  <Row t={{ type: "task", id: t.id }} depth={depth} covered={covered}
                    chevron={expandable ? tKey : undefined}
                    icon={<RoleDot role={t.role} />}
                    label={t.name} sub={`${t.instances.length} instance(s)${t.mode === "dynamic" ? " · dynamic" : ""}`} />
                  {expandable && !collapsed[tKey] && t.instances.map((i) => (
                    <Row key={i.vmid} t={{ type: "instance", vmid: i.vmid }} depth={depth + 1} covered={tOn}
                      icon={<Server className="h-3.5 w-3.5 text-muted-foreground" />}
                      label={i.name} sub={`#${i.vmid}`} />
                  ))}
                </div>
              );
            };

            const renderSg = (sg: PickSubgroup, depth: number, covered: boolean): React.ReactNode => {
              const sgKey = `sg:${g.id}:${sg.id}`;
              const sgOn = sel.has(sgKey) || covered;
              const sgTasks = visTasks.filter((t) => t.subgroupId === sg.id);
              const children = sgs.filter((s) => s.parentId === sg.id);
              if (taskFilter && sgTasks.length === 0 && children.length === 0) return null;
              return (
                <div key={sg.id} className="space-y-1">
                  <Row t={{ type: "subgroup", groupId: g.id, id: sg.id }} depth={depth} covered={covered}
                    chevron={sgKey}
                    icon={<CornerDownRight className="h-3.5 w-3.5 text-muted-foreground" />}
                    label={sg.name} sub={`${sgTasks.length} service(s)`} />
                  {!collapsed[sgKey] && (
                    <>
                      {sgTasks.map((t) => renderTask(t, depth + 1, sgOn))}
                      {children.map((c) => renderSg(c, depth + 1, sgOn))}
                    </>
                  )}
                </div>
              );
            };

            if (taskFilter && visTasks.length === 0) return null;
            return (
              <div key={g.id} className="space-y-1">
                <Row t={{ type: "group", id: g.id }} depth={0}
                  chevron={gKey + ":c"}
                  icon={<Boxes className="h-3.5 w-3.5 text-muted-foreground" />}
                  label={g.name} sub={`${visTasks.length} service(s)`} />
                {!collapsed[gKey + ":c"] && (
                  <>
                    {loose.map((t) => renderTask(t, 1, gSel))}
                    {sgs.filter((s) => !s.parentId).map((sg) => renderSg(sg, 1, gSel))}
                  </>
                )}
              </div>
            );
          })}
          {groups.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No servers yet.</p>}
        </div>
        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <span className="text-[12px] text-muted-foreground">{sel.size} selected</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => onSave(sel)}>Use selection</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
