"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { HelpButton } from "@/components/help-center";
import { Plus, X, Trash2, Boxes, Cpu, FileCode2, Download, Package } from "lucide-react";

const ROLES = ["lobby", "smp", "proxy", "db", "generic"];
// kinds with a built-in recipe; "generic" uses the custom recipe section below.
const KINDS = ["paper", "velocity", "mariadb", "hytale", "nginx", "generic"];

type OsTemplate = { volid: string; file: string; os: string };
type AssetRow = { url: string; dest: string };

function Section({ icon, title, help, children }: { icon: React.ReactNode; title: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {icon}{title}{help && <HelpButton topic={help} />}
      </div>
      {children}
    </div>
  );
}

export function NewTemplateDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [osTemplates, setOsTemplates] = useState<OsTemplate[]>([]);
  const [f, setF] = useState({
    name: "", role: "smp", kind: "paper", version: "latest", mode: "static",
    cores: 2, memory: 4096, disk: 12, port: 25565,
    description: "", longDescription: "", base: "", sharedAssets: false,
    packages: "", installScript: "", startCommand: "",
  });
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const isGeneric = f.kind === "generic";

  useEffect(() => {
    if (!open) return;
    fetch("/api/templates").then((r) => r.json()).then((j) => setOsTemplates(j.templates ?? [])).catch(() => {});
  }, [open]);

  async function submit() {
    if (!f.name.trim()) return toast.error("name required");
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: f.name, role: f.role, mode: f.mode,
        cores: f.cores, memory: f.memory, disk: f.disk, port: f.port,
        description: f.description, longDescription: f.longDescription || undefined,
        base: f.base || undefined, sharedAssets: f.sharedAssets,
        software: { kind: f.kind, version: f.version },
      };
      if (isGeneric) {
        body.custom = {
          packages: f.packages || undefined,
          assets: assets.filter((a) => a.url && a.dest),
          installScript: f.installScript || undefined,
          startCommand: f.startCommand || undefined,
        };
      }
      const res = await fetch("/api/blueprints", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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

  const input = "w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-[13px] outline-none";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="h-4 w-4" /> New Template
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Identity */}
          <Section icon={<Boxes className="h-3.5 w-3.5" />} title="Identity">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><Label className="mb-1 block text-xs">Name</Label>
                <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="BedWars" /></div>
              <div><Label className="mb-1 block text-xs">Role</Label>
                <Select value={f.role} onValueChange={(v) => set("role", v ?? "generic")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                </Select></div>
              <div><Label className="mb-1 flex items-center gap-1 text-xs">Software</Label>
                <Select value={f.kind} onValueChange={(v) => set("kind", v ?? "generic")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
                </Select></div>
              <div className="col-span-2"><Label className="mb-1 block text-xs">Short description (card)</Label>
                <Input value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="what this server is" /></div>
              <div className="col-span-2"><Label className="mb-1 block text-xs">Long description (detail view)</Label>
                <textarea value={f.longDescription} onChange={(e) => set("longDescription", e.target.value)} rows={2}
                  className={input} placeholder="A fuller explanation of exactly what this template does…" /></div>
            </div>
          </Section>

          {/* Base image + resources */}
          <Section icon={<Cpu className="h-3.5 w-3.5" />} title="Base image & resources" help="resources">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><Label className="mb-1 block text-xs">Base OS template</Label>
                <Select value={f.base || "__default"} onValueChange={(v) => set("base", v === "__default" ? "" : (v ?? ""))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default">Default (Debian 12)</SelectItem>
                    {osTemplates.map((t) => <SelectItem key={t.volid} value={t.volid}>{t.file}</SelectItem>)}
                  </SelectContent>
                </Select></div>
              <div><Label className="mb-1 block text-xs">Mode</Label>
                <Select value={f.mode} onValueChange={(v) => set("mode", v ?? "static")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="static">static</SelectItem>
                    <SelectItem value="dynamic">dynamic (autoscale)</SelectItem>
                  </SelectContent>
                </Select></div>
              <div><Label className="mb-1 block text-xs">Version</Label>
                <Input value={f.version} onChange={(e) => set("version", e.target.value)} placeholder="latest / 1.21.4" /></div>
              <div><Label className="mb-1 block text-xs">Cores</Label>
                <Input type="number" value={f.cores} onChange={(e) => set("cores", Number(e.target.value))} /></div>
              <div><Label className="mb-1 block text-xs">Memory (MB)</Label>
                <Input type="number" value={f.memory} onChange={(e) => set("memory", Number(e.target.value))} /></div>
              <div><Label className="mb-1 block text-xs">Disk (GB)</Label>
                <Input type="number" value={f.disk} onChange={(e) => set("disk", Number(e.target.value))} /></div>
              <div><Label className="mb-1 block text-xs">Port</Label>
                <Input type="number" value={f.port} onChange={(e) => set("port", Number(e.target.value))} /></div>
            </div>
          </Section>

          {/* Custom recipe — only for generic kind */}
          {isGeneric ? (
            <Section icon={<FileCode2 className="h-3.5 w-3.5" />} title="Custom provisioning recipe">
              <p className="text-[11px] text-muted-foreground/70">Runs in <code className="rounded bg-accent px-1">/opt/app</code> at first provision: install packages → pull assets → run install → supervise the start command.</p>

              <div><Label className="mb-1 flex items-center gap-1 text-xs"><Package className="h-3 w-3" /> apt packages</Label>
                <Input value={f.packages} onChange={(e) => set("packages", e.target.value)} placeholder="openjdk-21-jre-headless unzip" /></div>

              {/* Assets to pull */}
              <div>
                <Label className="mb-1 flex items-center gap-1 text-xs"><Download className="h-3 w-3" /> Assets to pull (URL → dest)</Label>
                <div className="space-y-1.5">
                  {assets.map((a, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input value={a.url} onChange={(e) => setAssets((s) => s.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} placeholder="https://…/server.jar" className={input} />
                      <span className="text-muted-foreground/50">→</span>
                      <input value={a.dest} onChange={(e) => setAssets((s) => s.map((x, j) => j === i ? { ...x, dest: e.target.value } : x))} placeholder="server.jar" className="w-40 rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 text-[13px] outline-none" />
                      <button onClick={() => setAssets((s) => s.filter((_, j) => j !== i))} className="shrink-0 text-destructive/60 hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                  <button onClick={() => setAssets((s) => [...s, { url: "", dest: "" }])} className="flex items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/50"><Plus className="h-3 w-3" /> Add asset</button>
                </div>
              </div>

              <div><Label className="mb-1 block text-xs">Install script (bash, runs once)</Label>
                <textarea value={f.installScript} onChange={(e) => set("installScript", e.target.value)} rows={4}
                  className={`${input} font-mono`} placeholder={"unzip server.zip\nchmod +x run.sh"} /></div>

              <div><Label className="mb-1 block text-xs">Start command (supervised)</Label>
                <Input value={f.startCommand} onChange={(e) => set("startCommand", e.target.value)} className="font-mono" placeholder="./run.sh" /></div>
            </Section>
          ) : (
            <div className="flex items-center justify-between rounded-md border border-hairline px-3 py-2">
              <div>
                <div className="text-sm">Shared read-only /assets mount</div>
                <div className="text-xs text-muted-foreground">For engines that share static assets (e.g. Hytale). Off for Minecraft.</div>
              </div>
              <Switch checked={f.sharedAssets} onCheckedChange={(v) => set("sharedAssets", v)} />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-hairline pt-3">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !f.name.trim()}>{busy ? "Creating…" : "Create template"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
