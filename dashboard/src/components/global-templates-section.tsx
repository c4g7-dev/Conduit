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
import { RoleDot } from "@/components/role-dot";
import { cn } from "@/lib/utils";
import { FileStack, Plus, Trash2, Settings2, FolderOpen, Loader2 } from "lucide-react";

type GlobalTemplate = { id: string; name: string; taskIds: string[]; createdAt: number };
type Task = { id: string; name: string; role: string };
type Group = { id: string; name: string; tasks: Task[] };
type State = { groups: Group[] };

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
    toast.success(`Template "${name}" created — edit its files in the file manager`);
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
            into <code className="rounded bg-muted px-1 font-mono text-xs">/var/lib/conduit/overlays/_tpl/&lt;id&gt;</code> via the file manager.
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
              <span>Edit files via the file manager · applies on deploy / re-sync</span>
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
            A named set of files applied to any services you pick. After creating it, add files to
            its folder in the file manager and choose its member services.
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
  tpl: GlobalTemplate; groups: Group[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(tpl.name);
  const [picked, setPicked] = useState<Set<string>>(new Set(tpl.taskIds));
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/global-templates/${tpl.id}?apply=1`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, taskIds: [...picked] }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`"${name}" saved — files re-synced to ${picked.size} service(s)`);
      onSaved();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
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
            <div className="space-y-3 rounded-md border border-hairline p-3">
              {groups.map((g) => (
                <div key={g.id}>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.name}</div>
                  <div className="space-y-0.5">
                    {g.tasks.map((t) => (
                      <label key={t.id} className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] transition-colors hover:bg-accent/50",
                        picked.has(t.id) && "bg-accent/40",
                      )}>
                        <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} className="h-3.5 w-3.5 accent-[var(--brand,#7c83ff)]" />
                        <RoleDot role={t.role} />
                        <span>{t.name}</span>
                      </label>
                    ))}
                    {g.tasks.length === 0 && <span className="px-2 text-[11px] text-muted-foreground/50">no servers</span>}
                  </div>
                </div>
              ))}
              {groups.length === 0 && <span className="text-[11px] text-muted-foreground/50">no servers yet</span>}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!name.trim() || busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save &amp; apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
