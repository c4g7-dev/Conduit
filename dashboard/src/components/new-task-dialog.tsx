"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Plus,
  Cpu,
  MemoryStick,
  HardDrive,
  Infinity as InfinityIcon,
  Pin,
  Cable,
  Gamepad2,
  Server,
  Database,
  Box,
  ChevronDown,
} from "lucide-react";

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

const ROLE_COLOR: Record<string, string> = {
  proxy: "#f97316",
  lobby: "#34d399",
  smp: "#38bdf8",
  db: "#a78bfa",
  generic: "#94a3b8",
};

const ROLE_ICON: Record<string, React.ElementType> = {
  proxy: Cable,
  lobby: Gamepad2,
  smp: Server,
  db: Database,
  generic: Box,
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-white/35">
      {children}
    </div>
  );
}

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
  const [assets, setAssets] = useState<{ kind: string; name: string; ref: string }[]>([]);

  useEffect(() => {
    fetch("/api/assets")
      .then((r) => r.json())
      .then((j) => setAssets(j.assets ?? []))
      .catch(() => {});
  }, []);

  const bp = useMemo(() => blueprints.find((b) => b.id === bpId), [blueprints, bpId]);
  const isProxy = bp?.role === "proxy";
  const isPaper = bp?.role === "lobby" || bp?.role === "smp";
  const kind = bp?.software?.kind;
  const versioned = kind === "paper" || kind === "velocity";

  useEffect(() => {
    if (blueprints.length === 1 && !bpId) setBpId(blueprints[0].id);
  }, [blueprints, bpId]);

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

  useEffect(() => {
    if (bp && !name) setName(bp.name);
  }, [bp]); // eslint-disable-line react-hooks/exhaustive-deps

  function buildSeed() {
    const plugins = pluginsText
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const properties: Record<string, string> = {};
    for (const line of propsText.split(/\n+/)) {
      const i = line.indexOf("=");
      if (i > 0) properties[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const seed: {
      worldUrl?: string;
      plugins?: string[];
      properties?: Record<string, string>;
    } = {};
    if (worldUrl.trim()) seed.worldUrl = worldUrl.trim();
    if (plugins.length) seed.plugins = plugins;
    if (Object.keys(properties).length) seed.properties = properties;
    return Object.keys(seed).length ? seed : undefined;
  }

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

  const selectedColor = bp ? (ROLE_COLOR[bp.role] ?? ROLE_COLOR.generic) : "#60a5fa";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white" />
        }
      >
        <Plus className="h-3.5 w-3.5" /> Add Task
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Blueprint selection */}
          <div>
            <FieldLabel>Blueprint</FieldLabel>
            {blueprints.length <= 6 ? (
              <div className="grid grid-cols-2 gap-2">
                {blueprints.map((b) => {
                  const Icon = ROLE_ICON[b.role] ?? Box;
                  const color = ROLE_COLOR[b.role] ?? ROLE_COLOR.generic;
                  const selected = bpId === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setBpId(b.id)}
                      className="relative flex items-center gap-2.5 overflow-hidden rounded-lg border p-3 text-left transition-all"
                      style={{
                        borderColor: selected
                          ? `color-mix(in oklch, ${color} 50%, transparent)`
                          : "rgba(255,255,255,0.07)",
                        background: selected
                          ? `color-mix(in oklch, ${color} 10%, oklch(0.155 0.006 265))`
                          : "oklch(0.155 0.006 265)",
                      }}
                    >
                      <div
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                        style={{
                          background: `color-mix(in oklch, ${color} 15%, transparent)`,
                        }}
                      >
                        <Icon className="h-3.5 w-3.5" style={{ color }} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-white/80">
                          {b.name}
                        </div>
                        <div className="text-[10px] text-white/30">
                          {b.software.kind} · {b.role}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <select
                value={bpId}
                onChange={(e) => setBpId(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white/80 outline-none focus:border-white/[0.15]"
              >
                <option value="">Choose a blueprint…</option>
                {blueprints.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {b.role}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Blueprint detail + version */}
          {bp && (
            <div
              className="rounded-lg border p-3 text-xs"
              style={{
                borderColor: `color-mix(in oklch, ${selectedColor} 20%, transparent)`,
                background: `color-mix(in oklch, ${selectedColor} 5%, oklch(0.12 0.005 265))`,
              }}
            >
              <p className="text-white/40">{bp.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className="flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    background: `color-mix(in oklch, ${selectedColor} 15%, transparent)`,
                    color: selectedColor,
                  }}
                >
                  {bp.mode === "dynamic" ? (
                    <InfinityIcon className="h-2.5 w-2.5" />
                  ) : (
                    <Pin className="h-2.5 w-2.5" />
                  )}
                  {bp.mode}
                </span>
                <span className="flex items-center gap-2 font-mono text-[10px] text-white/25">
                  <span className="flex items-center gap-0.5">
                    <Cpu className="h-3 w-3" />
                    {bp.cores}c
                  </span>
                  <span className="flex items-center gap-0.5">
                    <MemoryStick className="h-3 w-3" />
                    {bp.memory}MB
                  </span>
                  <span className="flex items-center gap-0.5">
                    <HardDrive className="h-3 w-3" />
                    {bp.disk}GB
                  </span>
                </span>
              </div>
              {versioned && (
                <div className="mt-2.5">
                  <FieldLabel>
                    {kind === "velocity" ? "Velocity version" : "Minecraft version"}
                  </FieldLabel>
                  {versions.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {versions.slice(0, 10).map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setVersion(v)}
                          className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                            version === v
                              ? "bg-white/[0.12] text-white/80"
                              : "text-white/30 hover:bg-white/[0.06] hover:text-white/60"
                          }`}
                        >
                          {v}
                          {v === bp.software.version ? (
                            <span className="ml-1 opacity-40">·default</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[11px] text-white/25">Loading versions…</span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Name + instances */}
          {bp && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Name</FieldLabel>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="spawn"
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/20 focus:border-white/[0.15]"
                />
              </div>
              <div>
                <FieldLabel>Initial instances</FieldLabel>
                <input
                  type="number"
                  min={0}
                  value={desired}
                  onChange={(e) => setDesired(Number(e.target.value))}
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-medium text-white/80 tabular-nums outline-none focus:border-white/[0.15]"
                />
              </div>
            </div>
          )}

          {/* Fronts */}
          {isProxy && frontCandidates.length > 0 && (
            <div>
              <FieldLabel>Routed backends</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {frontCandidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleFront(c.id)}
                    className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                      fronts.includes(c.id)
                        ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                        : "border-white/[0.08] text-white/30 hover:border-white/[0.15] hover:text-white/60"
                    }`}
                  >
                    {c.name} <span className="opacity-50">· {c.role}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Seed */}
          {isPaper && (
            <div>
              <button
                type="button"
                onClick={() => setShowSeed((s) => !s)}
                className="flex items-center gap-1.5 text-[11px] font-medium text-white/30 transition-colors hover:text-white/60"
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${showSeed ? "" : "-rotate-90"}`}
                />
                Seed — world, plugins &amp; config overrides
              </button>
              {showSeed && (
                <div className="mt-2 space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                  {assets.some((a) => a.kind === "worlds" || a.kind === "plugins") && (
                    <div>
                      <FieldLabel>Uploaded assets</FieldLabel>
                      <div className="flex flex-wrap gap-1.5">
                        {assets
                          .filter((a) => a.kind === "worlds")
                          .map((a) => (
                            <button
                              key={a.ref}
                              type="button"
                              onClick={() => setWorldUrl(a.ref)}
                              className={`rounded border px-2 py-0.5 text-[11px] ${
                                worldUrl === a.ref
                                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                  : "border-white/[0.08] text-white/30 hover:bg-white/[0.06]"
                              }`}
                            >
                              🌍 {a.name}
                            </button>
                          ))}
                        {assets
                          .filter((a) => a.kind === "plugins")
                          .map((a) => (
                            <button
                              key={a.ref}
                              type="button"
                              onClick={() =>
                                setPluginsText((t) => (t ? t + "\n" : "") + a.ref)
                              }
                              className="rounded border border-white/[0.08] px-2 py-0.5 text-[11px] text-white/30 hover:bg-white/[0.06]"
                            >
                              🔌 {a.name}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <FieldLabel>World URL</FieldLabel>
                    <input
                      value={worldUrl}
                      onChange={(e) => setWorldUrl(e.target.value)}
                      placeholder="https://…/world.tar.gz"
                      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-white/70 outline-none placeholder:text-white/20 focus:border-white/[0.15]"
                    />
                  </div>
                  <div>
                    <FieldLabel>Plugin JARs — one per line</FieldLabel>
                    <textarea
                      value={pluginsText}
                      onChange={(e) => setPluginsText(e.target.value)}
                      rows={2}
                      placeholder="https://…/SomePlugin.jar"
                      className="w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-white/70 outline-none placeholder:text-white/20 focus:border-white/[0.15]"
                    />
                  </div>
                  <div>
                    <FieldLabel>server.properties — key=value per line</FieldLabel>
                    <textarea
                      value={propsText}
                      onChange={(e) => setPropsText(e.target.value)}
                      rows={2}
                      placeholder={"difficulty=hard\npvp=true"}
                      className="w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 font-mono text-xs text-white/70 outline-none placeholder:text-white/20 focus:border-white/[0.15]"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-white/[0.06] pt-4">
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-sm text-white/40 transition-colors hover:bg-white/[0.04] hover:text-white/60"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!bp || !name.trim() || busy}
            className="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-40"
            style={{
              background: `color-mix(in oklch, ${selectedColor} 25%, transparent)`,
              border: `1px solid color-mix(in oklch, ${selectedColor} 30%, transparent)`,
              color: `color-mix(in oklch, ${selectedColor} 80%, white)`,
            }}
          >
            {busy ? "Creating…" : "Create & deploy"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
