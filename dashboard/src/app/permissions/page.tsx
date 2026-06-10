"use client";

/**
 * Permissions — Conduit's built-in LuckPerms editor (the web-editor equivalent, panel-native).
 * Reads/writes the shared Postgres directly; every mutation triggers `lp networksync` on a live
 * server so the whole network picks the change up instantly via Redis messaging.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  KeyRound, Search, Plus, Trash2, X, ChevronDown, Loader2,
  Milestone, Shield, User as UserIcon, ArrowRight, Scale, Tag,
} from "lucide-react";

/* ---- types (mirror /api/luckperms/*) -------------------------------------- */
type LpNode = { permission: string; value: boolean; server: string; world: string; expiry: number; contexts: string };
type LpGroup = { name: string; weight: number | null; prefix: string | null; parents: string[]; nodeCount: number };
type LpUser = { uuid: string; username: string | null; primaryGroup: string };
type LpTrack = { name: string; groups: string[] };
type LpStatus = { connected: boolean; host: string | null; initialized: boolean; error?: string };

type Target = { type: "group"; id: string } | { type: "user"; id: string; name: string };

/* ---- node taxonomy: each kind gets a precise hue (the LP badge system) ----- */
const KIND = {
  inheritance: { label: "inherit", color: "#60a5fa" }, // blue
  prefix: { label: "prefix", color: "#c084fc" },       // purple
  suffix: { label: "suffix", color: "#f472b6" },       // pink
  weight: { label: "weight", color: "#22d3ee" },       // cyan
  meta: { label: "meta", color: "#fbbf24" },           // amber
  display: { label: "display", color: "#a78bfa" },     // violet
  permission: { label: "perm", color: "#94a3b8" },     // slate
} as const;
type Kind = keyof typeof KIND;

function kindOf(p: string): Kind {
  if (p.startsWith("group.")) return "inheritance";
  if (p.startsWith("prefix.")) return "prefix";
  if (p.startsWith("suffix.")) return "suffix";
  if (p.startsWith("weight.")) return "weight";
  if (p.startsWith("meta.")) return "meta";
  if (p.startsWith("displayname.")) return "display";
  return "permission";
}

/** Human reading of a structured node ("group.admin" → "admin"). */
function nodeBody(p: string): string {
  const k = kindOf(p);
  if (k === "inheritance") return p.slice(6);
  if (k === "weight") return p.slice(7);
  if (k === "prefix" || k === "suffix") return p.split(".").slice(2).join(".");
  if (k === "display") return p.slice(12);
  return p;
}

const fmtExpiry = (e: number) => (e > 0 ? new Date(e * 1000).toLocaleString() : "never");

export default function PermissionsPage() {
  const { data: status } = usePoll<LpStatus>("/api/luckperms/status", 15000);
  const { data: groupsData, refresh: refreshGroups } = usePoll<{ groups: LpGroup[] }>("/api/luckperms/groups", 15000);
  const { data: tracksData, refresh: refreshTracks } = usePoll<{ tracks: LpTrack[] }>("/api/luckperms/tracks", 20000);

  const groups = useMemo(
    () => [...(groupsData?.groups ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.name.localeCompare(b.name)),
    [groupsData],
  );
  const tracks = tracksData?.tracks ?? [];

  const [target, setTarget] = useState<Target | null>(null);
  const [nodes, setNodes] = useState<LpNode[] | null>(null);
  const [userMeta, setUserMeta] = useState<LpUser | null>(null);
  const [busy, setBusy] = useState(false);

  // user search
  const [q, setQ] = useState("");
  const [found, setFound] = useState<LpUser[]>([]);
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim()) { setFound([]); return; }
      const r = await fetch(`/api/luckperms/users?q=${encodeURIComponent(q.trim())}`).then((x) => x.json()).catch(() => null);
      setFound(r?.users ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const loadNodes = useCallback(async (t: Target) => {
    setNodes(null);
    if (t.type === "group") {
      const r = await fetch(`/api/luckperms/groups/${encodeURIComponent(t.id)}`).then((x) => x.json());
      setNodes(r.nodes ?? []);
      setUserMeta(null);
    } else {
      const r = await fetch(`/api/luckperms/users/${encodeURIComponent(t.id)}`).then((x) => x.json());
      setNodes(r.nodes ?? []);
      setUserMeta(r.user ?? null);
    }
  }, []);

  function select(t: Target) { setTarget(t); loadNodes(t); }
  useEffect(() => { if (!target && groups.length) select({ type: "group", id: groups[0].name }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [groups.length]);

  const endpoint = (t: Target) =>
    t.type === "group" ? `/api/luckperms/groups/${encodeURIComponent(t.id)}` : `/api/luckperms/users/${encodeURIComponent(t.id)}`;

  async function mutate(method: "POST" | "DELETE", body: Record<string, unknown>, okMsg: string) {
    if (!target) return;
    setBusy(true);
    try {
      const r = await fetch(endpoint(target), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      toast.success(`${okMsg} · network synced`);
      await loadNodes(target);
      refreshGroups();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  const addNode = (n: Partial<LpNode> & { permission: string }) => mutate("POST", n, n.permission);
  const removeNode = (n: LpNode) => mutate("DELETE", { permission: n.permission, server: n.server, world: n.world }, `removed ${n.permission}`);
  const toggleValue = (n: LpNode) => mutate("POST", { ...n, value: !n.value }, `${n.permission} → ${!n.value}`);

  async function createGroup() {
    const name = prompt("New group name (lowercase):");
    if (!name?.trim()) return;
    const r = await fetch("/api/luckperms/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).then((x) => x.json());
    if (r.error) return toast.error(r.error);
    toast.success(`Group "${name}" created`);
    refreshGroups();
  }

  async function deleteGroup(name: string) {
    if (!confirm(`Delete group "${name}"? Its nodes and all inheritance references are removed.`)) return;
    const r = await fetch(`/api/luckperms/groups/${encodeURIComponent(name)}?group=1`, { method: "DELETE" }).then((x) => x.json());
    if (r.error) return toast.error(r.error);
    toast.success(`Group "${name}" deleted`);
    if (target?.type === "group" && target.id === name) setTarget(null);
    refreshGroups();
  }

  const [trackEdit, setTrackEdit] = useState<LpTrack | null>(null);

  const disconnected = status && !status.connected;
  const parents = nodes ? nodes.filter((n) => kindOf(n.permission) === "inheritance" && n.value).map((n) => nodeBody(n.permission)) : [];
  const weight = nodes ? (() => { const w = nodes.find((n) => kindOf(n.permission) === "weight" && n.value); return w ? nodeBody(w.permission) : null; })() : null;

  return (
    <>
      <PageHeader
        title="Permissions"
        subtitle="LuckPerms network permissions — edits apply live to every server"
        onRefresh={() => { refreshGroups(); refreshTracks(); if (target) loadNodes(target); }}
        loading={false}
      />

      {disconnected ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-hairline py-20 text-center">
          <KeyRound className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">LuckPerms storage not reachable</p>
          <p className="max-w-md text-sm text-muted-foreground">{status?.error ?? "Deploy the PostgreSQL egg, then install LuckPerms from Settings."}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 md:min-h-[calc(100vh-9rem)] md:flex-row">
          {/* ── Left rail: tracks → groups → users ─────────────────────── */}
          <div className="flex max-h-[45vh] w-full shrink-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel md:max-h-none md:w-72">
            <div className="flex-1 overflow-y-auto p-1.5">
              {/* Tracks */}
              <RailHeader label={`Tracks (${tracks.length})`} onAdd={() => setTrackEdit({ name: "", groups: [] })} />
              {tracks.map((t) => (
                <button
                  key={t.name}
                  onClick={() => setTrackEdit(t)}
                  className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  <Milestone className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  <span className="truncate font-medium">{t.name}</span>
                  <span className="ml-auto flex min-w-0 items-center gap-0.5 truncate font-mono text-[10px] text-muted-foreground/60">
                    {t.groups.slice(0, 3).map((g, i) => (
                      <span key={i} className="flex items-center gap-0.5">
                        {i > 0 && <ArrowRight className="h-2.5 w-2.5" />}{g}
                      </span>
                    ))}
                    {t.groups.length > 3 && "…"}
                  </span>
                </button>
              ))}
              {tracks.length === 0 && <RailEmpty text="no promotion tracks" />}

              {/* Groups */}
              <RailHeader label={`Groups (${groups.length})`} onAdd={createGroup} className="mt-4" />
              {groups.map((g) => {
                const active = target?.type === "group" && target.id === g.name;
                return (
                  <div key={g.name} className="group/row relative">
                    <button
                      onClick={() => select({ type: "group", id: g.name })}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors",
                        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <Shield className="h-3 w-3 shrink-0" style={{ color: KIND.inheritance.color }} />
                      <span className="flex-1 truncate">{g.name}</span>
                      {g.prefix && <span className="truncate font-mono text-[10px] text-muted-foreground/60">{g.prefix}</span>}
                      <span className="tabular-nums text-[11px] text-muted-foreground/60">{g.weight ?? "—"}</span>
                    </button>
                    {g.name !== "default" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteGroup(g.name); }}
                        className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-destructive/60 hover:bg-destructive/10 hover:text-destructive group-hover/row:block"
                        title="Delete group"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}

              {/* Users */}
              <RailHeader label="Users" className="mt-4" />
              <div className="mb-1 flex items-center gap-2 rounded border border-hairline px-2 py-1.5">
                <Search className="h-3 w-3 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search players…"
                  className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
                />
              </div>
              {found.map((u) => {
                const active = target?.type === "user" && target.id === u.uuid;
                return (
                  <button
                    key={u.uuid}
                    onClick={() => select({ type: "user", id: u.uuid, name: u.username ?? u.uuid })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors",
                      active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`https://mc-heads.net/avatar/${u.username ?? u.uuid}/16`} alt="" className="h-4 w-4 rounded-sm" />
                    <span className="flex-1 truncate">{u.username ?? u.uuid}</span>
                    <span className="text-[10px] text-muted-foreground/60">{u.primaryGroup}</span>
                  </button>
                );
              })}
              {q && found.length === 0 && <RailEmpty text="no players match (players appear after their first join)" />}
            </div>
          </div>

          {/* ── Right: target editor ───────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
            {!target ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Select a group or player</div>
            ) : (
              <>
                {/* Header */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline px-5 py-4">
                  <div className="flex items-center gap-3">
                    {target.type === "group" ? (
                      <div className="flex h-9 w-9 items-center justify-center rounded-md" style={{ background: `color-mix(in oklch, ${KIND.inheritance.color} 16%, transparent)` }}>
                        <Shield className="h-4.5 w-4.5" style={{ color: KIND.inheritance.color }} />
                      </div>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`https://mc-heads.net/avatar/${(target as { name: string }).name}/36`} alt="" className="h-9 w-9 rounded-md" />
                    )}
                    <div>
                      <div className="flex items-center gap-2 text-[15px] font-semibold">
                        {target.type === "group" ? target.id : (target as { name: string }).name}
                        <span className="rounded bg-accent px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {target.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                        {target.type === "user" && userMeta && (
                          <span>primary: <span className="text-foreground">{userMeta.primaryGroup}</span></span>
                        )}
                        {weight && <span className="flex items-center gap-1"><Scale className="h-3 w-3" /> weight {weight}</span>}
                        <span>{nodes?.length ?? "…"} nodes</span>
                      </div>
                    </div>
                  </div>

                  {/* Parent chips */}
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <span className="eyebrow mr-1">Parents</span>
                    {parents.map((p) => (
                      <span key={p} className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium" style={{ background: `color-mix(in oklch, ${KIND.inheritance.color} 14%, transparent)`, color: KIND.inheritance.color }}>
                        {p}
                        <button onClick={() => removeNode({ permission: `group.${p}`, value: true, server: "global", world: "global", expiry: 0, contexts: "{}" })} className="opacity-60 hover:opacity-100">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    <AddParent groups={groups.map((g) => g.name)} exclude={[...parents, ...(target.type === "group" ? [target.id] : [])]} onAdd={(g) => addNode({ permission: `group.${g}` })} />
                  </div>
                </div>

                {/* Nodes table */}
                <div className="flex-1 overflow-y-auto">
                  {!nodes ? (
                    <div className="flex h-32 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                  ) : nodes.length === 0 ? (
                    <div className="py-16 text-center text-sm text-muted-foreground">No nodes yet — add the first one below.</div>
                  ) : (
                    <table className="w-full min-w-[560px] text-[13px]">
                      <thead className="sticky top-0 bg-panel">
                        <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Node</th>
                          <th className="px-3 py-2 font-medium">Value</th>
                          <th className="px-3 py-2 font-medium">Context</th>
                          <th className="px-3 py-2 font-medium">Expiry</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {nodes.map((n, i) => {
                          const k = kindOf(n.permission);
                          const c = KIND[k];
                          return (
                            <tr key={`${n.permission}|${n.server}|${n.world}|${i}`} className="group border-b border-hairline last:border-0 hover:bg-accent/40">
                              <td className="px-4 py-2">
                                <span className="flex items-center gap-2">
                                  <span className="w-14 shrink-0 rounded px-1.5 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide" style={{ background: `color-mix(in oklch, ${c.color} 14%, transparent)`, color: c.color }}>
                                    {c.label}
                                  </span>
                                  <span className="break-all font-mono text-xs">{k === "permission" ? n.permission : nodeBody(n.permission)}</span>
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <button
                                  onClick={() => toggleValue(n)}
                                  disabled={busy}
                                  className={cn("rounded px-2 py-0.5 font-mono text-[11px] font-semibold transition-colors", n.value ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25" : "bg-red-500/15 text-red-400 hover:bg-red-500/25")}
                                  title="Toggle value"
                                >
                                  {String(n.value)}
                                </button>
                              </td>
                              <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                                {n.server === "global" && n.world === "global" ? <span className="text-muted-foreground/40">global</span> : `${n.server}${n.world !== "global" ? ` · ${n.world}` : ""}`}
                              </td>
                              <td className="px-3 py-2 text-[11px] text-muted-foreground">{fmtExpiry(n.expiry)}</td>
                              <td className="px-3 py-2 text-right">
                                <button onClick={() => removeNode(n)} disabled={busy} className="hidden rounded p-1 text-destructive/60 hover:bg-destructive/10 hover:text-destructive group-hover:inline-block" title="Remove node">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                <AddNodeBar busy={busy} groups={groups.map((g) => g.name)} onAdd={addNode} />
              </>
            )}
          </div>
        </div>
      )}

      {trackEdit && (
        <TrackDialog
          track={trackEdit}
          groups={groups.map((g) => g.name)}
          onClose={() => setTrackEdit(null)}
          onSaved={() => { setTrackEdit(null); refreshTracks(); }}
        />
      )}
    </>
  );
}

/* ---- rail bits ------------------------------------------------------------ */
function RailHeader({ label, onAdd, className }: { label: string; onAdd?: () => void; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between px-2 py-1.5", className)}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      {onAdd && (
        <button onClick={onAdd} className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="Create">
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
function RailEmpty({ text }: { text: string }) {
  return <div className="px-2 py-1 text-[11px] text-muted-foreground/50">{text}</div>;
}

/* ---- parent adder ---------------------------------------------------------- */
function AddParent({ groups, exclude, onAdd }: { groups: string[]; exclude: string[]; onAdd: (g: string) => void }) {
  const [open, setOpen] = useState(false);
  const avail = groups.filter((g) => !exclude.includes(g));
  if (avail.length === 0) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-0.5 rounded border border-hairline px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <Plus className="h-3 w-3" /> add <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 max-h-48 w-36 overflow-y-auto rounded-md border border-hairline bg-panel py-1 shadow-lg">
          {avail.map((g) => (
            <button key={g} onClick={() => { setOpen(false); onAdd(g); }} className="block w-full px-3 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">
              {g}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- add-node bar ----------------------------------------------------------
 * Type-aware composer: the inputs adapt to the node kind and compose the final
 * LuckPerms node string (prefix.<weight>.<text>, weight.<n>, meta.<k>.<v>, …).
 * The permission field accepts MANY nodes pasted at once (whitespace/comma split). */
function AddNodeBar({ busy, groups, onAdd }: { busy: boolean; groups: string[]; onAdd: (n: { permission: string; value?: boolean; server?: string; world?: string; expiry?: number }) => void }) {
  const [kind, setKind] = useState<"permission" | "parent" | "prefix" | "suffix" | "weight" | "meta">("permission");
  const [perm, setPerm] = useState("");
  const [value, setValue] = useState(true);
  const [server, setServer] = useState("");
  const [expiry, setExpiry] = useState("");
  const [metaKey, setMetaKey] = useState("");
  const [pWeight, setPWeight] = useState("100");

  function submit() {
    const ctx = { server: server.trim() || undefined, expiry: expiry ? Math.floor(new Date(expiry).getTime() / 1000) : undefined };
    if (kind === "permission") {
      const many = perm.split(/[\s,]+/).filter(Boolean);
      if (many.length === 0) return;
      for (const p of many) onAdd({ permission: p, value, ...ctx });
    } else if (kind === "parent") {
      if (!perm) return;
      onAdd({ permission: `group.${perm}`, ...ctx });
    } else if (kind === "weight") {
      if (!perm) return;
      onAdd({ permission: `weight.${perm}`, ...ctx });
    } else if (kind === "prefix" || kind === "suffix") {
      if (!perm) return;
      onAdd({ permission: `${kind}.${pWeight || "100"}.${perm}`, ...ctx });
    } else if (kind === "meta") {
      if (!metaKey || !perm) return;
      onAdd({ permission: `meta.${metaKey}.${perm}`, ...ctx });
    }
    setPerm("");
  }

  const KINDS: { id: typeof kind; label: string; color: string }[] = [
    { id: "permission", label: "Permission", color: KIND.permission.color },
    { id: "parent", label: "Parent", color: KIND.inheritance.color },
    { id: "prefix", label: "Prefix", color: KIND.prefix.color },
    { id: "suffix", label: "Suffix", color: KIND.suffix.color },
    { id: "weight", label: "Weight", color: KIND.weight.color },
    { id: "meta", label: "Meta", color: KIND.meta.color },
  ];

  return (
    <div className="border-t border-hairline bg-panel-2/50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => { setKind(k.id); setPerm(""); }}
            className={cn("rounded px-2 py-1 text-[11px] font-medium transition-colors", kind === k.id ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
            style={kind === k.id ? { background: `color-mix(in oklch, ${k.color} 16%, transparent)`, color: k.color } : undefined}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {kind === "parent" ? (
          <select value={perm} onChange={(e) => setPerm(e.target.value)} className="h-8 rounded-md border border-hairline bg-transparent px-2 text-[13px] outline-none">
            <option value="">select group…</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        ) : (
          <>
            {kind === "meta" && (
              <input value={metaKey} onChange={(e) => setMetaKey(e.target.value)} placeholder="key" className="h-8 w-28 rounded-md border border-hairline bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/50" />
            )}
            {(kind === "prefix" || kind === "suffix") && (
              <input value={pWeight} onChange={(e) => setPWeight(e.target.value.replace(/\D/g, ""))} placeholder="priority" className="h-8 w-20 rounded-md border border-hairline bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/50" title="Priority (higher wins)" />
            )}
            <input
              value={perm}
              onChange={(e) => setPerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder={
                kind === "permission" ? "enter permissions — or paste many" :
                kind === "weight" ? "weight number (higher wins)" :
                kind === "meta" ? "value" : `${kind} text (& colors ok)`
              }
              className="h-8 min-w-44 flex-1 rounded-md border border-hairline bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/50"
            />
          </>
        )}
        {kind === "permission" && (
          <button onClick={() => setValue((v) => !v)} className={cn("h-8 rounded-md px-2.5 font-mono text-[11px] font-semibold", value ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")} title="Node value">
            {String(value)}
          </button>
        )}
        <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="server (global)" className="h-8 w-32 rounded-md border border-hairline bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/50" title="Server context — a task name like timesmp, or empty for global" />
        <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="h-8 rounded-md border border-hairline bg-transparent px-2 text-xs text-muted-foreground outline-none" title="Expiry (empty = permanent)" />
        <Button size="sm" onClick={submit} disabled={busy} className="h-8">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
        </Button>
      </div>
    </div>
  );
}

/* ---- track editor ----------------------------------------------------------
 * A track is an ordered ladder of groups (low → high) used by /lp promote|demote. */
function TrackDialog({ track, groups, onClose, onSaved }: { track: LpTrack; groups: string[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !track.name;
  const [name, setName] = useState(track.name);
  const [ladder, setLadder] = useState<string[]>(track.groups);
  const [busy, setBusy] = useState(false);
  const avail = groups.filter((g) => !ladder.includes(g));

  async function save() {
    setBusy(true);
    try {
      const r = await fetch("/api/luckperms/tracks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, groups: ladder }) }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      toast.success(`Track "${name}" saved · network synced`);
      onSaved();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm(`Delete track "${track.name}"?`)) return;
    await fetch("/api/luckperms/tracks", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: track.name }) });
    toast.success(`Track "${track.name}" deleted`);
    onSaved();
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ladder.length) return;
    const next = [...ladder];
    [next[i], next[j]] = [next[j], next[i]];
    setLadder(next);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Milestone className="h-4 w-4 text-brand" /> {isNew ? "New track" : `Track: ${track.name}`}</DialogTitle>
          <DialogDescription>
            An ordered ladder of groups, low → high — <code>/lp user &lt;x&gt; promote {name || "<track>"}</code> moves a player one rung up.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {isNew && (
            <div className="space-y-2">
              <Label htmlFor="tr-name">Name</Label>
              <Input id="tr-name" placeholder="staff" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          <div className="space-y-2">
            <Label>Ladder (low → high)</Label>
            <div className="space-y-1">
              {ladder.map((g, i) => (
                <div key={g} className="flex items-center gap-2 rounded-md border border-hairline px-2 py-1.5 text-[13px]">
                  <span className="w-5 text-center font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                  <Tag className="h-3 w-3" style={{ color: KIND.inheritance.color }} />
                  <span className="flex-1">{g}</span>
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === ladder.length - 1} className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30">↓</button>
                  <button onClick={() => setLadder(ladder.filter((x) => x !== g))} className="rounded p-0.5 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"><X className="h-3 w-3" /></button>
                </div>
              ))}
              {ladder.length === 0 && <p className="py-2 text-center text-xs text-muted-foreground">No groups yet — add rungs below.</p>}
            </div>
            {avail.length > 0 && (
              <select value="" onChange={(e) => { if (e.target.value) setLadder([...ladder, e.target.value]); }} className="h-8 w-full rounded-md border border-hairline bg-transparent px-2 text-[13px] outline-none">
                <option value="">+ add group to ladder…</option>
                {avail.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
          </div>
        </div>
        <DialogFooter className="flex items-center justify-between sm:justify-between">
          {!isNew ? (
            <Button variant="outline" onClick={del} className="border-destructive/40 text-destructive hover:bg-destructive/10">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={!name.trim() || busy}>{busy ? "Saving…" : "Save track"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
