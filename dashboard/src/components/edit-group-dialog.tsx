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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pencil } from "lucide-react";

export function EditGroupDialog({
  group,
  onSaved,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  showTrigger = true,
}: {
  group: { id: string; name: string; slotLimit: number; maintenance?: boolean };
  onSaved: () => void;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  showTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : internalOpen;
  const setOpen = (o: boolean) => (controlled ? controlledOnOpenChange?.(o) : setInternalOpen(o));
  const [name, setName] = useState(group.name);
  const [slotLimit, setSlotLimit] = useState(group.slotLimit);
  const [maintenance, setMaintenance] = useState(!!group.maintenance);
  const [busy, setBusy] = useState(false);

  // reset fields to the latest group values whenever the dialog opens
  function onOpenChange(o: boolean) {
    if (o) {
      setName(group.name);
      setSlotLimit(group.slotLimit);
      setMaintenance(!!group.maintenance);
    }
    setOpen(o);
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/groups/" + group.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slotLimit, maintenance }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Group "${name}" updated`);
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(`Could not update group: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {showTrigger && (
        <DialogTrigger
          render={
            <Button size="icon" variant="ghost" className="h-8 w-8" title="Edit group" />
          }
        >
          <Pencil className="h-4 w-4" />
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Group settings · {group.name}</DialogTitle>
          <DialogDescription>
            Display name, the network slot limit, and maintenance mode. The pool id stays the same.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="eg-name">Name</Label>
            <Input
              id="eg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              pool id: <code className="rounded bg-muted px-1">{group.id}</code> (unchanged)
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="eg-slot">Slot limit</Label>
            <Input
              id="eg-slot"
              type="number"
              value={slotLimit}
              onChange={(e) => setSlotLimit(Number(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              The network player cap shown on the proxy (its <code className="rounded bg-muted px-1">max players</code>).
            </p>
          </div>
          <label className="flex items-center gap-2.5 rounded-md border border-hairline px-3 py-2.5 text-sm">
            <input type="checkbox" checked={maintenance} onChange={(e) => setMaintenance(e.target.checked)} className="h-4 w-4 accent-[var(--brand,#7c83ff)]" />
            <span>
              <span className="block">Maintenance mode</span>
              <span className="block text-xs text-muted-foreground">Blocks non-admin players from joining the proxy (needs <code className="rounded bg-muted px-1">conduit.maintenance.bypass</code>).</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
