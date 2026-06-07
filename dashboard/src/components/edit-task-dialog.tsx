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

export function EditTaskDialog({
  task,
  onSaved,
}: {
  task: {
    id: string;
    name: string;
    min: number;
    max: number;
    cores: number;
    memory: number;
    disk: number;
  };
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState(task.min);
  const [max, setMax] = useState(task.max);
  const [cores, setCores] = useState(task.cores);
  const [memory, setMemory] = useState(task.memory);
  const [disk, setDisk] = useState(task.disk);
  const [busy, setBusy] = useState(false);

  // reset fields to the latest task values whenever the dialog opens
  function onOpenChange(o: boolean) {
    if (o) {
      setMin(task.min);
      setMax(task.max);
      setCores(task.cores);
      setMemory(task.memory);
      setDisk(task.disk);
    }
    setOpen(o);
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/tasks/" + task.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ min, max, cores, memory, disk }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Task "${task.name}" updated`);
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(`Could not update task: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit task" />
        }
      >
        <Pencil className="h-3.5 w-3.5" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
          <DialogDescription>
            Adjust the scaling range and per-instance resources for{" "}
            <span className="font-medium text-foreground">{task.name}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="et-min">Min instances</Label>
              <Input
                id="et-min"
                type="number"
                min={0}
                value={min}
                onChange={(e) => setMin(Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="et-max">Max instances</Label>
              <Input
                id="et-max"
                type="number"
                min={0}
                value={max}
                onChange={(e) => setMax(Number(e.target.value))}
              />
              <p className="text-[11px] text-muted-foreground">0 = unlimited</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="et-cores">Cores</Label>
              <Input
                id="et-cores"
                type="number"
                min={1}
                value={cores}
                onChange={(e) => setCores(Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="et-memory">Memory (MB)</Label>
              <Input
                id="et-memory"
                type="number"
                min={1}
                value={memory}
                onChange={(e) => setMemory(Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="et-disk">Disk (GB)</Label>
              <Input
                id="et-disk"
                type="number"
                min={1}
                value={disk}
                onChange={(e) => setDisk(Number(e.target.value))}
              />
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Cores / memory / disk only apply to newly provisioned instances — existing
            LXCs are not resized.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
