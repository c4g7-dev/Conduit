"use client";

import { useEffect, useMemo, useRef } from "react";

/* ----------------------------- data shapes ------------------------------ */

export type Instance = {
  vmid: number;
  name: string;
  node: string;
  status: string;
  ip: string | null;
  ready: boolean;
};
export type Task = {
  id: string;
  name: string;
  role: string;
  softwareKind: string;
  version: string;
  fronts: string[];
  instances: Instance[];
};
export type Group = { id: string; name: string; tasks: Task[] };
export type Backend = {
  taskId: string;
  taskName: string;
  role: string;
  vmid: number;
  name: string;
  ip: string | null;
  port: number;
  status: string;
};
export type Routing = {
  proxy: { id: string; name: string };
  proxyInstances: { vmid: number; ip: string | null; status: string }[];
  backends: Backend[];
};
export type ConduitState = { groups: Group[]; routing: Routing[] };
export type MetricRow = {
  vmid: number;
  role: string;
  reachable: boolean;
  online: number;
  max: number;
  sample: { name: string }[];
  version?: string;
};
export type Metrics = {
  instances: MetricRow[];
  totals: { players: number; capacity: number };
};

/* ------------------------------- geometry -------------------------------- */

const W = 1200;
const H = 760;

const COL = {
  players: 150,
  proxy: 470,
  backend: 880,
};

type Node = {
  key: string;
  x: number;
  y: number;
  kind: "proxy" | "backend";
  title: string;
  sub: string;
  pnode?: string; // proxmox node
  online: number;
  max: number;
  online_ratio: number;
  reachable: boolean;
  accent: string; // hex
};

type Link = {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  flow: number; // 0..1 particle density driver
  accent: string;
};

/* role → accent colour (hex so SVG filters/gradients work) */
const ROLE_ACCENT: Record<string, string> = {
  proxy: "#fb923c", // orange
  lobby: "#34d399", // emerald
  smp: "#38bdf8", // sky
  db: "#a78bfa", // violet
  generic: "#94a3b8", // slate
};

/* deterministic colour per proxmox node, for the node badges */
const NODE_TINTS = ["#fb923c", "#34d399", "#38bdf8", "#a78bfa", "#f472b6", "#facc15"];
function nodeTint(name: string, order: string[]): string {
  const i = order.indexOf(name);
  return NODE_TINTS[(i < 0 ? 0 : i) % NODE_TINTS.length];
}

/* cubic bezier path string between two points, horizontal-ish S curve */
function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(60, (b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/* ----------------------------- the component ----------------------------- */

export function FlowGraph({
  state,
  metrics,
}: {
  state: ConduitState | null;
  metrics: Metrics | null;
}) {
  const mByVmid = useMemo(
    () => new Map((metrics?.instances ?? []).map((r) => [r.vmid, r])),
    [metrics],
  );

  /* distinct proxmox nodes, in first-seen order, for tinting + legend */
  const pxNodes = useMemo(() => {
    const seen: string[] = [];
    for (const g of state?.groups ?? [])
      for (const t of g.tasks)
        for (const i of t.instances) if (!seen.includes(i.node)) seen.push(i.node);
    return seen;
  }, [state]);

  /* ---- build proxy nodes from routing ---- */
  const { nodes, links, totalPlayers, samplePlayers } = useMemo(() => {
    const routing = state?.routing ?? [];

    // backends are addressed by their task; collect every backend instance once,
    // keyed by vmid, but remember which proxies front it (for links).
    type BData = {
      vmid: number;
      name: string;
      role: string;
      pnode: string;
      ip: string | null;
    };
    const backendMap = new Map<number, BData>();

    // map taskId -> its instances (to resolve proxmox node + ip per backend vmid)
    const instByVmid = new Map<number, Instance>();
    for (const g of state?.groups ?? [])
      for (const t of g.tasks) for (const i of t.instances) instByVmid.set(i.vmid, i);

    const proxyNodes: Node[] = [];
    const linkList: Link[] = [];

    const proxyCount = Math.max(1, routing.length);
    routing.forEach((r, pi) => {
      const accent = ROLE_ACCENT.proxy;
      const online = r.proxyInstances.reduce(
        (n, p) => n + (mByVmid.get(p.vmid)?.online ?? 0),
        0,
      );
      const max = r.proxyInstances.reduce(
        (n, p) => n + (mByVmid.get(p.vmid)?.max ?? 0),
        0,
      );
      const reachable = r.proxyInstances.some((p) => mByVmid.get(p.vmid)?.reachable);
      const ip = r.proxyInstances.map((p) => p.ip).find(Boolean) ?? null;
      const firstInst = r.proxyInstances.length
        ? instByVmid.get(r.proxyInstances[0].vmid)
        : undefined;
      const py = ((pi + 1) / (proxyCount + 1)) * H;
      const pkey = `proxy-${r.proxy.id}`;
      proxyNodes.push({
        key: pkey,
        x: COL.proxy,
        y: py,
        kind: "proxy",
        title: r.proxy.name,
        sub: ip ?? "no instance up",
        pnode: firstInst?.node,
        online,
        max,
        online_ratio: max > 0 ? online / max : 0,
        reachable,
        accent,
      });

      // register backends fronted by this proxy
      for (const b of r.backends) {
        if (!backendMap.has(b.vmid)) {
          const inst = instByVmid.get(b.vmid);
          backendMap.set(b.vmid, {
            vmid: b.vmid,
            name: b.name,
            role: b.role,
            pnode: inst?.node ?? "—",
            ip: b.ip,
          });
        }
      }
    });

    // lay out backends in a column, grouped loosely by appearance order
    const backendArr = [...backendMap.values()];
    const bn = Math.max(1, backendArr.length);
    const backendNodes: Node[] = backendArr.map((b, bi) => {
      const m = mByVmid.get(b.vmid);
      const accent = ROLE_ACCENT[b.role] ?? ROLE_ACCENT.generic;
      const by = ((bi + 1) / (bn + 1)) * H;
      return {
        key: `backend-${b.vmid}`,
        x: COL.backend,
        y: by,
        kind: "backend" as const,
        title: b.name,
        sub: b.ip ?? "…dhcp",
        pnode: b.pnode,
        online: m?.online ?? 0,
        max: m?.max ?? 0,
        online_ratio: m && m.max > 0 ? m.online / m.max : 0,
        reachable: !!m?.reachable,
        accent,
      };
    });

    const byKeyVmid = new Map<number, Node>();
    backendNodes.forEach((n) =>
      byKeyVmid.set(Number(n.key.replace("backend-", "")), n),
    );

    // proxy -> backend links
    routing.forEach((r) => {
      const pn = proxyNodes.find((n) => n.key === `proxy-${r.proxy.id}`);
      if (!pn) return;
      for (const b of r.backends) {
        const bnode = byKeyVmid.get(b.vmid);
        if (!bnode) continue;
        const m = mByVmid.get(b.vmid);
        const ratio = m && m.max > 0 ? m.online / m.max : 0;
        linkList.push({
          key: `${pn.key}->${bnode.key}`,
          from: { x: pn.x + 110, y: pn.y },
          to: { x: bnode.x - 110, y: bnode.y },
          flow: Math.min(1, 0.12 + ratio),
          accent: bnode.accent,
        });
      }
    });

    // players cluster -> proxy links
    const playersAnchor = { x: COL.players + 60, y: H / 2 };
    let total = 0;
    proxyNodes.forEach((pn) => {
      total += pn.online;
      linkList.push({
        key: `players->${pn.key}`,
        from: playersAnchor,
        to: { x: pn.x - 110, y: pn.y },
        flow: Math.min(1, 0.1 + pn.online_ratio),
        accent: ROLE_ACCENT.proxy,
      });
    });

    // collect some sample player names (from any reachable proxy/backend)
    const names: string[] = [];
    for (const row of metrics?.instances ?? [])
      if (row.reachable)
        for (const s of row.sample ?? []) if (names.length < 14) names.push(s.name);

    return {
      nodes: [...proxyNodes, ...backendNodes],
      links: linkList,
      totalPlayers: metrics?.totals.players ?? total,
      samplePlayers: names,
    };
  }, [state, metrics, mByVmid]);

  const hasData = (state?.routing?.length ?? 0) > 0 || nodes.length > 0;

  /* -------------------- particle animation (rAF + canvas overlay) ------- */
  const pathRefs = useRef<Map<string, SVGPathElement>>(new Map());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  // particle phase store keyed by link; persists across renders
  const particlesRef = useRef<Map<string, number[]>>(new Map());
  const linksRef = useRef<Link[]>(links);
  linksRef.current = links;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio : 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      for (const link of linksRef.current) {
        const path = pathRefs.current.get(link.key);
        if (!path) continue;
        const len = path.getTotalLength();
        if (!len) continue;

        // particle count scales with flow (player density)
        const count = 2 + Math.round(link.flow * 9);
        let phases = particlesRef.current.get(link.key);
        if (!phases || phases.length !== count) {
          phases = Array.from({ length: count }, (_, i) => i / count);
          particlesRef.current.set(link.key, phases);
        }
        const speed = 0.18 + link.flow * 0.5; // fraction of path / sec

        for (let i = 0; i < phases.length; i++) {
          phases[i] = (phases[i] + speed * dt) % 1;
          const pt = path.getPointAtLength(phases[i] * len);
          // fade in/out at the ends
          const edge = Math.min(phases[i], 1 - phases[i]);
          const alpha = Math.min(1, edge * 6) * (0.55 + link.flow * 0.45);
          const r = 1.6 + link.flow * 1.8;

          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
          ctx.fillStyle = withAlpha(link.accent, alpha);
          ctx.shadowColor = link.accent;
          ctx.shadowBlur = 8;
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  /* player cluster dots (stable jittered positions) */
  const playerDots = useMemo(() => {
    const n = Math.min(48, Math.max(0, totalPlayers));
    const cx = COL.players,
      cy = H / 2;
    const dots: { x: number; y: number; name?: string }[] = [];
    for (let i = 0; i < n; i++) {
      // deterministic golden-angle spiral
      const a = i * 2.399963;
      const rad = 14 + Math.sqrt(i) * 14;
      dots.push({
        x: cx + Math.cos(a) * rad * 0.78,
        y: cy + Math.sin(a) * rad,
        name: samplePlayers[i],
      });
    }
    return dots;
  }, [totalPlayers, samplePlayers]);

  /* ------------------------------- render -------------------------------- */

  if (!state && !metrics) {
    return <GraphSkeleton />;
  }
  if (!hasData) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/30 text-center">
        <div className="text-sm font-medium text-muted-foreground">No services on the network yet</div>
        <div className="mt-1 text-xs text-muted-foreground/70">
          Deploy a proxy + backend task to see the live flow graph.
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border/60 bg-[#0a0c10]">
      {/* subtle grid backdrop */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(148,163,184,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.06) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_-10%,rgba(251,146,60,0.08),transparent_55%)]" />

      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full"
          style={{ height: "auto" }}
        >
          <defs>
            <filter id="fg-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <linearGradient id="fg-link" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(148,163,184,0.05)" />
              <stop offset="50%" stopColor="rgba(148,163,184,0.22)" />
              <stop offset="100%" stopColor="rgba(148,163,184,0.05)" />
            </linearGradient>
          </defs>

          {/* column headers */}
          <ColHeader x={COL.players} label="PLAYERS" />
          <ColHeader x={COL.proxy} label="PROXIES" />
          <ColHeader x={COL.backend} label="BACKENDS" />

          {/* links (static base path); particles drawn on canvas overlay */}
          <g>
            {links.map((l) => (
              <path
                key={l.key}
                ref={(el) => {
                  if (el) pathRefs.current.set(l.key, el);
                  else pathRefs.current.delete(l.key);
                }}
                d={curve(l.from, l.to)}
                fill="none"
                stroke="url(#fg-link)"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            ))}
          </g>

          {/* players cluster */}
          <g>
            {playerDots.map((d, i) => (
              <g key={i}>
                <circle
                  cx={d.x}
                  cy={d.y}
                  r={3.4}
                  fill="#fb923c"
                  opacity={0.9}
                  filter="url(#fg-glow)"
                />
                {d.name && i < 6 && (
                  <text
                    x={d.x + 7}
                    y={d.y + 3}
                    className="fill-slate-300"
                    fontSize="9"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    {d.name.length > 12 ? d.name.slice(0, 11) + "…" : d.name}
                  </text>
                )}
              </g>
            ))}
            <text
              x={COL.players}
              y={H / 2 + 130}
              textAnchor="middle"
              className="fill-orange-300"
              fontSize="26"
              fontWeight={700}
            >
              {totalPlayers}
            </text>
            <text
              x={COL.players}
              y={H / 2 + 150}
              textAnchor="middle"
              className="fill-slate-500"
              fontSize="11"
            >
              online
            </text>
          </g>

          {/* nodes */}
          {nodes.map((n) => (
            <NodeCard key={n.key} n={n} tint={n.pnode ? nodeTint(n.pnode, pxNodes) : "#94a3b8"} />
          ))}
        </svg>

        {/* canvas overlay for flowing particles, sized to match the svg box */}
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={{ width: "100%", height: "100%" }}
        />
      </div>

      {/* legend: proxmox nodes */}
      {pxNodes.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          <span className="uppercase tracking-wide text-[10px] text-muted-foreground/70">
            Proxmox nodes
          </span>
          {pxNodes.map((nm) => (
            <span key={nm} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: nodeTint(nm, pxNodes), boxShadow: `0 0 6px ${nodeTint(nm, pxNodes)}` }}
              />
              {nm}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- pieces ---------------------------------- */

function ColHeader({ x, label }: { x: number; label: string }) {
  return (
    <text
      x={x}
      y={26}
      textAnchor="middle"
      className="fill-slate-500"
      fontSize="11"
      letterSpacing="2"
      fontWeight={600}
    >
      {label}
    </text>
  );
}

function NodeCard({ n, tint }: { n: Node; tint: string }) {
  const w = 200;
  const h = 64;
  const x = n.x - w / 2;
  const y = n.y - h / 2;
  const dim = !n.reachable;
  return (
    <g opacity={dim ? 0.55 : 1}>
      {/* glow ring keyed to role accent */}
      <rect
        x={x - 1}
        y={y - 1}
        width={w + 2}
        height={h + 2}
        rx={12}
        fill="none"
        stroke={n.accent}
        strokeOpacity={0.5}
        strokeWidth={1.5}
        filter="url(#fg-glow)"
      />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={11}
        fill="rgba(17,20,27,0.92)"
        stroke="rgba(148,163,184,0.15)"
        strokeWidth={1}
      />
      {/* accent bar */}
      <rect x={x} y={y} width={4} height={h} rx={2} fill={n.accent} />

      {/* status dot */}
      <circle
        cx={x + 16}
        cy={y + 18}
        r={4}
        fill={n.reachable ? "#34d399" : "#64748b"}
      />
      {n.reachable && (
        <circle cx={x + 16} cy={y + 18} r={4} fill="#34d399">
          <animate attributeName="r" values="4;8;4" dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.6;0;0.6" dur="2s" repeatCount="indefinite" />
        </circle>
      )}

      {/* title */}
      <text x={x + 28} y={y + 22} className="fill-slate-100" fontSize="13" fontWeight={600}>
        {n.title.length > 18 ? n.title.slice(0, 17) + "…" : n.title}
      </text>
      {/* sub (ip) */}
      <text
        x={x + 28}
        y={y + 38}
        className="fill-slate-400"
        fontSize="10"
        fontFamily="var(--font-mono, monospace)"
      >
        {n.sub}
      </text>

      {/* players badge */}
      {n.reachable && (
        <text
          x={x + w - 12}
          y={y + 22}
          textAnchor="end"
          fill={n.accent}
          fontSize="13"
          fontWeight={700}
        >
          {n.online}
          <tspan className="fill-slate-500" fontSize="10" fontWeight={400}>
            /{n.max}
          </tspan>
        </text>
      )}

      {/* proxmox node badge */}
      {n.pnode && (
        <g>
          <rect
            x={x + w - 78}
            y={y + h - 20}
            width={66}
            height={14}
            rx={7}
            fill="rgba(148,163,184,0.08)"
          />
          <circle cx={x + w - 70} cy={y + h - 13} r={3} fill={tint} />
          <text
            x={x + w - 63}
            y={y + h - 9}
            className="fill-slate-400"
            fontSize="9"
          >
            {n.pnode.length > 9 ? n.pnode.slice(0, 8) + "…" : n.pnode}
          </text>
        </g>
      )}
    </g>
  );
}

function GraphSkeleton() {
  return (
    <div className="relative h-[60vh] w-full animate-pulse overflow-hidden rounded-xl border border-border/60 bg-[#0a0c10]">
      <div className="absolute inset-0 grid grid-cols-3 place-items-center">
        {[0, 1, 2].map((c) => (
          <div key={c} className="flex flex-col gap-6">
            {[0, 1, 2].map((r) => (
              <div
                key={r}
                className="h-14 w-48 rounded-xl border border-border/40 bg-card/40"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- helpers --------------------------------- */

function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}
