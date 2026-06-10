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
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Create a subgroup (Untergruppe) inside a group — controlled (opened from a context menu). */
export function NewSubgroupDialog({ groupId, groupName, open, onOpenChange, onCreated }: {
  groupId: string;
  groupName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch(`/api/groups/${groupId}/subgroups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Subgroup "${name}" created`);
      setName("");
      onOpenChange(false);
      onCreated();
    } catch (e) {
      toast.error(`Could not create subgroup: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New subgroup in {groupName}</DialogTitle>
          <DialogDescription>
            A subgroup separates servers inside a group into an addressable unit — toggle
            maintenance or run ops on just this slice (e.g. <code>timesmp</code>) without
            touching the rest of the group.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="sg-name">Name</Label>
          <Input
            id="sg-name"
            placeholder="Time SMP"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) submit(); }}
          />
          {name && (
            <p className="text-xs text-muted-foreground">
              id: <code className="rounded bg-muted px-1">{name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}</code>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create subgroup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
