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
import { McText } from "@/components/mc-text";

export function EditGroupDialog({
  group,
  onSaved,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  showTrigger = true,
}: {
  group: { id: string; name: string; slotLimit: number; maintenance?: boolean; fullMessage?: string };
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
  const [fullMessage, setFullMessage] = useState(group.fullMessage ?? "");
  const [busy, setBusy] = useState(false);

  // reset fields to the latest group values whenever the dialog opens
  function onOpenChange(o: boolean) {
    if (o) {
      setName(group.name);
      setSlotLimit(group.slotLimit);
      setFullMessage(group.fullMessage ?? "");
    }
    setOpen(o);
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/groups/" + group.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slotLimit, fullMessage: fullMessage.trim() ? fullMessage : null }),
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
            Display name, the network player cap and its kick message. Maintenance is toggled from
            the group&apos;s right-click menu. The pool id stays the same.
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
              ENFORCED at the proxy: logins are denied (pre-auth, near-zero cost) once this many
              players are online. Bypass: <code className="rounded bg-muted px-1">conduit.full.bypass</code>.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="eg-full">Full message</Label>
            <Input
              id="eg-full"
              placeholder="&8[&bConduit&8] &cThe network is full."
              value={fullMessage}
              onChange={(e) => setFullMessage(e.target.value)}
            />
            <div className="rounded-md bg-black/40 px-2 py-1.5 text-xs">
              <McText text={fullMessage || "&8[&bConduit&8] &cThe network is full."} />
            </div>
          </div>
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
