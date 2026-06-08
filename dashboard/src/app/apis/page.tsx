"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { API_ENDPOINTS, API_GROUPS, type ApiEndpoint, type Method } from "@/lib/api-registry";
import { Search, Play, Loader2, AlertTriangle, Radio } from "lucide-react";

const METHOD_COLOR: Record<Method, string> = {
  GET: "#34d399", POST: "#7c83ff", PUT: "#38bdf8", PATCH: "#fbbf24", DELETE: "#f87171",
};

function MethodTag({ m }: { m: Method }) {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums" style={{ background: `color-mix(in oklch, ${METHOD_COLOR[m]} 16%, transparent)`, color: METHOD_COLOR[m] }}>
      {m}
    </span>
  );
}

function endpointKey(e: ApiEndpoint) { return `${e.method} ${e.path}`; }

export default function ApiExplorerPage() {
  const [selected, setSelected] = useState<ApiEndpoint>(API_ENDPOINTS[0]);
  const [search, setSearch] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [resp, setResp] = useState<{ status: number; ms: number; text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false); // confirm gate for mutations

  // Reset the form whenever the selected endpoint changes; auto-run safe GETs.
  useEffect(() => {
    const p: Record<string, string> = {};
    selected.params?.forEach((x) => (p[x.name] = x.example));
    setParams(p);
    setQuery(selected.query ?? "");
    setBody(selected.sampleBody ? JSON.stringify(selected.sampleBody, null, 2) : "");
    setResp(null);
    setArmed(false);
    if (selected.safe && !selected.stream) {
      // run after state settles
      const t = setTimeout(() => run(p, selected.query ?? ""), 0);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  function buildUrl(p = params, q = query) {
    let path = selected.path;
    for (const [k, v] of Object.entries(p)) path = path.replace(`:${k}`, encodeURIComponent(v));
    return path + (q ? `?${q}` : "");
  }

  async function run(p = params, q = query) {
    if (selected.stream) return;
    setBusy(true);
    setResp(null);
    const started = performance.now();
    try {
      const init: RequestInit = { method: selected.method };
      if (selected.method !== "GET" && body.trim()) {
        init.headers = { "Content-Type": "application/json" };
        init.body = body;
      }
      const res = await fetch(buildUrl(p, q), init);
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not json */ }
      setResp({ status: res.status, ms: Math.round(performance.now() - started), text: pretty, ok: res.ok });
    } catch (e) {
      setResp({ status: 0, ms: Math.round(performance.now() - started), text: String(e), ok: false });
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  const q = search.trim().toLowerCase();
  const grouped = useMemo(() => API_GROUPS.map((g) => ({
    group: g,
    items: API_ENDPOINTS.filter((e) => e.group === g && (!q || e.path.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q))),
  })).filter((s) => s.items.length), [q]);

  const isMutation = selected.method !== "GET";

  return (
    <>
      <PageHeader title="API" subtitle="Explore and debug Conduit's HTTP API against the live system" />

      <div className="flex min-h-[calc(100vh-9rem)] gap-4">
        {/* Endpoint list */}
        <div className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
          <div className="flex items-center gap-2 border-b border-hairline px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search endpoints…"
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60" />
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {grouped.map((s) => (
              <div key={s.group} className="mb-1">
                <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{s.group}</div>
                <div className="space-y-px">
                  {s.items.map((e) => {
                    const active = endpointKey(e) === endpointKey(selected);
                    return (
                      <button key={endpointKey(e)} onClick={() => setSelected(e)}
                        className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors", active ? "bg-accent" : "hover:bg-accent/50")}>
                        <MethodTag m={e.method} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/90">{e.path}</span>
                        {e.stream && <Radio className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail / debugger */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="panel p-4">
            <div className="flex items-center gap-2.5">
              <MethodTag m={selected.method} />
              <code className="font-mono text-sm">{selected.path}</code>
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">{selected.desc}</p>

            {/* Path params */}
            {selected.params && selected.params.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {selected.params.map((pr) => (
                  <label key={pr.name} className="text-[11px] text-muted-foreground">
                    <span className="font-mono">:{pr.name}</span>
                    <input value={params[pr.name] ?? ""} onChange={(e) => setParams((s) => ({ ...s, [pr.name]: e.target.value }))}
                      className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-[13px] text-foreground outline-none" />
                  </label>
                ))}
              </div>
            )}

            {/* Query */}
            {(selected.query !== undefined) && (
              <label className="mt-3 block text-[11px] text-muted-foreground">query string
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="key=value&…"
                  className="mt-1 w-full rounded-md border border-hairline bg-accent/30 px-2.5 py-1.5 font-mono text-[13px] outline-none" />
              </label>
            )}

            {/* Body */}
            {isMutation && (
              <label className="mt-3 block text-[11px] text-muted-foreground">request body (JSON)
                <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} rows={6}
                  className="mt-1 w-full resize-y rounded-md border border-hairline bg-accent/30 p-2.5 font-mono text-[12px] outline-none" />
              </label>
            )}

            {/* Actions */}
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-hairline bg-accent/20 px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground">{buildUrl()}</code>
              {selected.stream ? (
                <span className="flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[13px] text-muted-foreground"><Radio className="h-3.5 w-3.5" /> SSE stream</span>
              ) : isMutation && !armed ? (
                <button onClick={() => setArmed(true)}
                  className={cn("flex items-center gap-1.5 rounded-md px-4 py-1.5 text-[13px] font-medium", selected.destructive ? "bg-destructive/15 text-destructive" : "bg-accent text-foreground hover:bg-panel-2")}>
                  <AlertTriangle className="h-3.5 w-3.5" /> {selected.destructive ? "Arm destructive call" : "Confirm send"}
                </button>
              ) : (
                <button onClick={() => run()} disabled={busy}
                  className="flex items-center gap-1.5 rounded-md bg-brand px-4 py-1.5 text-[13px] font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-40">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Send
                </button>
              )}
            </div>
            {isMutation && armed && (
              <p className="mt-2 text-[11px] text-amber-400">Armed — press Send to execute the {selected.method} request against the live system.</p>
            )}
          </div>

          {/* Response */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline" style={{ background: "#16191e" }}>
            <div className="flex items-center justify-between border-b border-hairline px-4 py-2">
              <span className="font-mono text-xs text-muted-foreground">response</span>
              {resp && (
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn("rounded px-1.5 py-0.5 font-semibold tabular-nums", resp.ok ? "text-emerald-400" : "text-destructive")} style={{ background: `color-mix(in oklch, ${resp.ok ? "#34d399" : "#f87171"} 14%, transparent)` }}>{resp.status || "ERR"}</span>
                  <span className="font-mono text-muted-foreground">{resp.ms} ms</span>
                </div>
              )}
            </div>
            <pre className="flex-1 overflow-auto p-4 font-mono text-[12px] leading-relaxed" style={{ color: "#c9d1d9" }}>
              {busy ? "…" : resp ? resp.text : (selected.stream ? "This is a streaming (SSE) endpoint — open the service console to view it live." : selected.safe ? "" : "Configure and Send to see the live response.")}
            </pre>
          </div>
        </div>
      </div>
    </>
  );
}
