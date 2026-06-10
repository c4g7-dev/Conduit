"use client";

/** Settings for a subgroup (Untergruppe): rename, player cap (enforced at the proxy), and
 *  the custom deny message shown when the cap is reached. */
import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { McText } from "@/components/mc-text";

type Subgroup = { id: string; name: string; maintenance: boolean; slotLimit?: number; fullMessage?: string; parentId?: string };

export function SubgroupSettingsDialog({ groupId, sg, open, onOpenChange, onSaved }: {
  groupId: string;
  sg: Subgroup;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(sg.name);
  const [limit, setLimit] = useState(sg.slotLimit ? String(sg.slotLimit) : "");
  const [msg, setMsg] = useState(sg.fullMessage ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/groups/${groupId}/subgroups/${sg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          slotLimit: limit.trim() ? Number(limit) : null,
          fullMessage: msg.trim() ? msg : null,
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Subgroup "${name}" saved`);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subgroup: {sg.name}</DialogTitle>
          <DialogDescription>
            The player cap is enforced by the proxy — connects into this subgroup&apos;s servers are
            denied once its total online count reaches the limit (bypass: <code>conduit.full.bypass</code>).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="sgs-name">Name</Label>
            <Input id="sgs-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sgs-limit">Player cap</Label>
            <Input
              id="sgs-limit"
              type="number"
              min={0}
              placeholder="unlimited"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Total players across all servers in this subgroup (nested included). Empty = unlimited.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sgs-msg">Full message</Label>
            <Input
              id="sgs-msg"
              placeholder={`&8[&bConduit&8] &7${name} &cis full.`}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
            />
            {(msg || name) && (
              <div className="rounded-md bg-black/40 px-2 py-1.5 text-xs">
                <McText text={msg || `&8[&bConduit&8] &7${name} &cis full.`} />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!name.trim() || busy}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
