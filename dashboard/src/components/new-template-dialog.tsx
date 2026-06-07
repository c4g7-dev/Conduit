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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Plus } from "lucide-react";

const ROLES = ["lobby", "smp", "proxy", "db", "generic"];
const KINDS = ["paper", "velocity", "mariadb", "hytale", "generic"];

export function NewTemplateDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    name: "",
    role: "smp",
    kind: "paper",
    version: "latest",
    mode: "static",
    cores: 2,
    memory: 4096,
    disk: 12,
    port: 25565,
    description: "",
    sharedAssets: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    if (!f.name.trim()) return toast.error("name required");
    setBusy(true);
    try {
      const res = await fetch("/api/blueprints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: f.name,
          role: f.role,
          mode: f.mode,
          cores: f.cores,
          memory: f.memory,
          disk: f.disk,
          port: f.port,
          description: f.description,
          sharedAssets: f.sharedAssets,
          software: { kind: f.kind, version: f.version },
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Template "${f.name}" created`);
      setOpen(false);
      onCreated();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="h-4 w-4" /> New Template
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            A custom blueprint. Tasks built from it provision LXCs with this role,
            software and resources. paper/velocity install automatically; other kinds
            come up as a base container for now.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="tpl-name">Name</Label>
            <Input id="tpl-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="BedWars" />
          </div>

          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={f.role} onValueChange={(v) => set("role", v ?? "generic")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Software</Label>
            <Select value={f.kind} onValueChange={(v) => set("kind", v ?? "generic")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Mode</Label>
            <Select value={f.mode} onValueChange={(v) => set("mode", v ?? "static")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="static">static</SelectItem>
                <SelectItem value="dynamic">dynamic (autoscale)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-ver">Version</Label>
            <Input id="tpl-ver" value={f.version} onChange={(e) => set("version", e.target.value)} placeholder="latest / 1.21.4" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tpl-cores">Cores</Label>
            <Input id="tpl-cores" type="number" value={f.cores} onChange={(e) => set("cores", Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-mem">Memory (MB)</Label>
            <Input id="tpl-mem" type="number" value={f.memory} onChange={(e) => set("memory", Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-disk">Disk (GB)</Label>
            <Input id="tpl-disk" type="number" value={f.disk} onChange={(e) => set("disk", Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-port">Port</Label>
            <Input id="tpl-port" type="number" value={f.port} onChange={(e) => set("port", Number(e.target.value))} />
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="tpl-desc">Description</Label>
            <Input id="tpl-desc" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="what this server is" />
          </div>

          <div className="col-span-2 flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <div>
              <div className="text-sm">Shared read-only /assets mount</div>
              <div className="text-xs text-muted-foreground">For engines that share static assets (e.g. Hytale). Leave off for Minecraft.</div>
            </div>
            <Switch checked={f.sharedAssets} onCheckedChange={(v) => set("sharedAssets", v)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !f.name.trim()}>
            {busy ? "Creating…" : "Create template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
