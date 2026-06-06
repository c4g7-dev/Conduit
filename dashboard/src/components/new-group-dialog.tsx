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
import { Plus } from "lucide-react";

export function NewGroupDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slotLimit, setSlotLimit] = useState(500);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slotLimit }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Group "${name}" created`);
      setOpen(false);
      setName("");
      onCreated();
    } catch (e) {
      toast.error(`Could not create group: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="h-4 w-4" /> New Group
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New server group</DialogTitle>
          <DialogDescription>
            A group is a Proxmox resource pool that bundles tasks and applies a
            shared slot limit and maintenance flag.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="g-name">Name</Label>
            <Input
              id="g-name"
              placeholder="Time SMP"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {name && (
              <p className="text-xs text-muted-foreground">
                pool id: <code className="rounded bg-muted px-1">{name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}</code>
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="g-slot">Slot limit</Label>
            <Input
              id="g-slot"
              type="number"
              value={slotLimit}
              onChange={(e) => setSlotLimit(Number(e.target.value))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
