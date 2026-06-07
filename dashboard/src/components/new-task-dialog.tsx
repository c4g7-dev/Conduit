"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Plus, Cpu, MemoryStick, HardDrive } from "lucide-react";

type Blueprint = {
  id: string;
  name: string;
  role: string;
  mode: "dynamic" | "static";
  persistent: boolean;
  cores: number;
  memory: number;
  disk: number;
  port: number;
  description: string;
  software: { kind: string; version: string };
};

type FrontCandidate = { id: string; name: string; role: string };

export function NewTaskDialog({
  groupId,
  blueprints,
  frontCandidates,
  onCreated,
}: {
  groupId: string;
  blueprints: Blueprint[];
  frontCandidates: FrontCandidate[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [bpId, setBpId] = useState("");
  const [desired, setDesired] = useState(1);
  const [fronts, setFronts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [worldUrl, setWorldUrl] = useState("");
  const [pluginsText, setPluginsText] = useState("");
  const [propsText, setPropsText] = useState("");
  const [version, setVersion] = useState("");
  const [versions, setVersions] = useState<string[]>([]);

  const bp = useMemo(() => blueprints.find((b) => b.id === bpId), [blueprints, bpId]);
  const isProxy = bp?.role === "proxy";
  const isPaper = bp?.role === "lobby" || bp?.role === "smp";
  const kind = bp?.software?.kind;
  const versioned = kind === "paper" || kind === "velocity";

  // when the blueprint changes, default the version and fetch selectable ones
  useEffect(() => {
    if (!bp) return;
    setVersion(bp.software.version);
    setVersions([]);
    if (bp.software.kind === "paper" || bp.software.kind === "velocity") {
      fetch(`/api/versions?kind=${bp.software.kind}`)
        .then((r) => r.json())
        .then((j) => setVersions(Array.isArray(j.versions) ? j.versions : []))
        .catch(() => setVersions([]));
    }
  }, [bp]); // eslint-disable-line react-hooks/exhaustive-deps

  function buildSeed() {
    const plugins = pluginsText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const properties: Record<string, string> = {};
    for (const line of propsText.split(/\n+/)) {
      const i = line.indexOf("=");
      if (i > 0) properties[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const seed: { worldUrl?: string; plugins?: string[]; properties?: Record<string, string> } = {};
    if (worldUrl.trim()) seed.worldUrl = worldUrl.trim();
    if (plugins.length) seed.plugins = plugins;
    if (Object.keys(properties).length) seed.properties = properties;
    return Object.keys(seed).length ? seed : undefined;
  }

  useEffect(() => {
    if (bp && !name) setName(bp.name);
    if (bp) setDesired(bp.mode === "dynamic" ? 1 : 1);
  }, [bp]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!bp) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          groupId,
          blueprintId: bp.id,
          desired,
          fronts: isProxy ? fronts : [],
          seed: isProxy ? undefined : buildSeed(),
          software: versioned && version ? { version } : undefined,
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Task "${name}" created — provisioning…`);
      setOpen(false);
      setName("");
      setBpId("");
      setFronts([]);
      setWorldUrl("");
      setPluginsText("");
      setPropsText("");
      setShowSeed(false);
      setVersion("");
      setVersions([]);
      onCreated();
    } catch (e) {
      toast.error(`Could not create task: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleFront(id: string) {
    setFronts((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Plus className="h-4 w-4" /> Add Task
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            A task provisions LXC instances from a blueprint and keeps the desired
            count alive. The controller does the rest.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Blueprint</Label>
            <Select value={bpId} onValueChange={(v) => setBpId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a premade blueprint…" />
              </SelectTrigger>
              <SelectContent>
                {blueprints.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name} · {b.role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {bp && (
              <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                <p>{bp.description}</p>
                <div className="mt-2 flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={
                      bp.mode === "dynamic"
                        ? "border-orange-500/30 bg-orange-500/10 text-orange-400"
                        : "border-sky-500/30 bg-sky-500/10 text-sky-400"
                    }
                  >
                    {bp.mode}
                  </Badge>
                  <span className="flex items-center gap-1"><Cpu className="h-3 w-3" />{bp.cores}c</span>
                  <span className="flex items-center gap-1"><MemoryStick className="h-3 w-3" />{bp.memory}MB</span>
                  <span className="flex items-center gap-1"><HardDrive className="h-3 w-3" />{bp.disk}GB</span>
                </div>
              </div>
            )}
          </div>

          {bp && (
            <div className="space-y-2">
              <Label>{kind === "velocity" ? "Velocity version" : kind === "paper" ? "Minecraft version" : "Version"}</Label>
              {versioned ? (
                <Select value={version} onValueChange={(v) => setVersion(v ?? "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Loading versions…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(versions.length ? versions : [bp.software.version]).map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                        {v === bp.software.version ? " · default" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {bp.software.kind} · {bp.software.version}
                </p>
              )}
              {kind === "paper" && (
                <p className="text-[11px] text-muted-foreground">
                  Java is auto-selected (17 for ≤1.20.4, 21 for 1.20.5+).
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="t-name">Name</Label>
              <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="spawn" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-desired">Initial instances</Label>
              <Input
                id="t-desired"
                type="number"
                min={0}
                value={desired}
                onChange={(e) => setDesired(Number(e.target.value))}
              />
            </div>
          </div>

          {isProxy && frontCandidates.length > 0 && (
            <div className="space-y-2">
              <Label>Fronts (backends this proxy routes to)</Label>
              <div className="flex flex-wrap gap-2">
                {frontCandidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleFront(c.id)}
                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                      fronts.includes(c.id)
                        ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                        : "border-border text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {c.name} · {c.role}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isPaper && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowSeed((s) => !s)}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {showSeed ? "▾" : "▸"} Seed (world / plugins / config){" "}
                <span className="text-muted-foreground/70">— overrides the blueprint default</span>
              </button>
              {showSeed && (
                <div className="space-y-3 rounded-md border border-border/60 p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="seed-world" className="text-xs">World tarball URL</Label>
                    <Input
                      id="seed-world"
                      value={worldUrl}
                      onChange={(e) => setWorldUrl(e.target.value)}
                      placeholder="https://…/world.tar.gz (extracts to world/)"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="seed-plugins" className="text-xs">Plugin jar URLs (one per line)</Label>
                    <textarea
                      id="seed-plugins"
                      value={pluginsText}
                      onChange={(e) => setPluginsText(e.target.value)}
                      rows={2}
                      placeholder="https://…/SomePlugin.jar"
                      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="seed-props" className="text-xs">server.properties overrides (key=value per line)</Label>
                    <textarea
                      id="seed-props"
                      value={propsText}
                      onChange={(e) => setPropsText(e.target.value)}
                      rows={2}
                      placeholder={"difficulty=hard\npvp=true"}
                      className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!bp || !name.trim() || busy}>
            {busy ? "Creating…" : "Create & deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
