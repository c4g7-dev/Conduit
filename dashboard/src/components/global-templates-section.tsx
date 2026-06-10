"use client";

/**
 * Named generic file templates (ideas.md §2): create a template with a name, pick which
 * services receive its files (overlays/_tpl/<id>/ on the shared store, file-manager editable).
 * The overlay chain applies them to every member service alongside the egg + kind-wide layers.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TargetPickerDialog, expandToTaskIds, type PickGroup, type PickTarget } from "@/components/target-picker-dialog";
import { FileStack, Plus, Trash2, Settings2, FolderOpen, Loader2, Crosshair, ChevronDown } from "lucide-react";

type GlobalTemplate = { id: string; name: string; taskIds: string[]; createdAt: number };
type State = { groups: PickGroup[] };

export function GlobalTemplatesSection() {
  const { data, refresh } = usePoll<{ templates: GlobalTemplate[] }>("/api/global-templates", 20000);
  const { data: state } = usePoll<State>("/api/conduit/state", 15000);
  const allTasks = useMemo(() => (state?.groups ?? []).flatMap((g) => g.tasks.map((t) => ({ ...t, group: g.name }))), [state]);
  const taskName = useMemo(() => new Map(allTasks.map((t) => [t.id, t.name])), [allTasks]);

  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<GlobalTemplate | null>(null);
  const templates = data?.templates ?? [];

  async function create(name: string) {
    const res = await fetch("/api/global-templates", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    const json = await res.json();
    if (json.error) return toast.error(json.error);
    toast.success(`Template "${name}" created — add its files in the Files tab under overlays/_tpl`);
    setCreating(false);
    refresh();
  }

  async function del(t: GlobalTemplate) {
    if (!confirm(`Delete template "${t.name}"? Its files are removed; member services keep their current files until next re-sync.`)) return;
    await fetch(`/api/global-templates/${t.id}`, { method: "DELETE" });
    toast.success(`Template "${t.name}" deleted`);
    refresh();
  }

  return (
    <>
      <div className="mb-3 mt-8 flex items-center justify-between">
        <h2 className="eyebrow">Global templates · shared files across chosen services</h2>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New template
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {templates.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed border-hairline py-10 text-center text-sm text-muted-foreground">
            No global templates yet. Create one, pick its services, then drop shared config/plugins
            into <code className="rounded bg-muted px-1 font-mono text-xs">overlays/_tpl/&lt;id&gt;</code> in the Files tab.
          </div>
        )}
        {templates.map((t) => (
          <div key={t.id} className="flex flex-col rounded-lg border border-hairline bg-panel p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand/10">
                <FileStack className="h-4.5 w-4.5 text-brand" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{t.name}</div>
                <div className="font-mono text-[11px] text-muted-foreground">_tpl/{t.id}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="icon" variant="ghost" className="h-7 w-7" title="Members & settings" onClick={() => setEdit(t)}>
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive/60 hover:text-destructive" title="Delete" onClick={() => del(t)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1">
              {t.taskIds.length === 0 && <span className="text-[11px] text-muted-foreground/60">applies to no services yet</span>}
              {t.taskIds.map((id) => (
                <span key={id} className="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {taskName.get(id) ?? id}
                </span>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-3 text-[11px] text-muted-foreground">
              <FolderOpen className="h-3 w-3" />
              <span>Files tab → <code className="font-mono">overlays/_tpl/{t.id}</code> · applies on deploy / re-sync</span>
            </div>
          </div>
        ))}
      </div>

      {creating && <CreateDialog onClose={() => setCreating(false)} onCreate={create} />}
      {edit && (
        <MembersDialog
          tpl={edit}
          groups={state?.groups ?? []}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); refresh(); }}
        />
      )}
    </>
  );
}

function CreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileStack className="h-4 w-4 text-brand" /> New global template</DialogTitle>
          <DialogDescription>
            A named set of files applied to any services you pick. After creating it, add files in
            the Files tab under <code>overlays/_tpl/&lt;id&gt;</code> and choose its member services.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="gt-name">Name</Label>
          <Input id="gt-name" autoFocus placeholder="Anti-cheat config" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim()); }} />
          {name && <p className="text-xs text-muted-foreground">id: <code className="rounded bg-muted px-1">{name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}</code></p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onCreate(name.trim())} disabled={!name.trim()}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({ tpl, groups, onClose, onSaved }: {
  tpl: GlobalTemplate; groups: PickGroup[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(tpl.name);
  // membership is a flat task list — seed the tree picker with task targets
  const [picked, setPicked] = useState<Map<string, PickTarget>>(
    new Map(tpl.taskIds.map((id) => [`t:${id}`, { type: "task" as const, id }])),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const taskName = useMemo(() => new Map(groups.flatMap((g) => g.tasks.map((t) => [t.id, t.name] as const))), [groups]);
  const taskIds = useMemo(() => expandToTaskIds(groups, picked), [groups, picked]);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/global-templates/${tpl.id}?apply=1`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, taskIds }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`"${name}" saved — files re-synced to ${taskIds.length} service(s)`);
      onSaved();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><FileStack className="h-4 w-4 text-brand" /> {tpl.name}</DialogTitle>
            <DialogDescription>Pick which services receive this template&apos;s files. Saving re-syncs the files to every affected service (no restart).</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="gt-rename">Name</Label>
              <Input id="gt-rename" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Member services</Label>
              <button
                onClick={() => setPickerOpen(true)}
                className="flex w-full items-center gap-2 rounded-md border border-hairline bg-accent/30 px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-accent/50"
              >
                <Crosshair className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {taskIds.length === 0 ? (
                  <span className="text-muted-foreground/60">Choose groups, subgroups or services…</span>
                ) : (
                  <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                    {taskIds.slice(0, 5).map((id) => (
                      <span key={id} className="rounded bg-accent px-1.5 py-0.5 text-[11px]">{taskName.get(id) ?? id}</span>
                    ))}
                    {taskIds.length > 5 && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px]">+{taskIds.length - 5}</span>}
                  </span>
                )}
                <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
              <p className="text-xs text-muted-foreground">Selecting a group/subgroup includes all its services. Dynamic services receive the files on every fresh provision.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={!name.trim() || busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save &amp; apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {pickerOpen && (
        <TargetPickerDialog
          groups={groups}
          picked={picked}
          onClose={() => setPickerOpen(false)}
          onSave={(next) => { setPicked(next); setPickerOpen(false); }}
          title="Choose member services"
          description="Templates apply per service — a whole service gets the files (all instances, never a subset). Selecting a parent includes everything inside it."
          allowInstances={false}
        />
      )}
    </>
  );
}
