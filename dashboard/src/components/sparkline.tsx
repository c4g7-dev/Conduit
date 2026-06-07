"use client";

import { useId } from "react";

type SparklineProps = {
  data: number[];
  /** Stroke / fill accent color (any CSS color). Defaults to emerald. */
  color?: string;
  /** Upper bound for the y-axis. Defaults to the data max (or 1). */
  max?: number;
  /** SVG height in px. Width fills the container. */
  height?: number;
  label?: string;
};

const VIEW_W = 100; // viewBox is normalized; SVG scales to container width

/** Hand-rolled SVG area + line chart. No dependencies. */
export function Sparkline({
  data,
  color = "var(--color-emerald-400, #34d399)",
  max,
  height = 48,
  label,
}: SparklineProps) {
  const gid = useId().replace(/:/g, "");
  const pts = data.filter((n) => Number.isFinite(n));

  if (pts.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={label}
      />
    );
  }

  const top = Math.max(max ?? Math.max(...pts), 1e-6);
  const stepX = VIEW_W / (pts.length - 1);
  const y = (v: number) => {
    const clamped = Math.max(0, Math.min(v, top));
    // 1px padding top/bottom so the stroke isn't clipped
    return height - 1 - (clamped / top) * (height - 2);
  };

  const coords = pts.map((v, i) => [i * stepX, y(v)] as const);
  const line = coords
    .map(([x, yy], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${yy.toFixed(2)}`)
    .join(" ");
  const area =
    `M0,${height} ` +
    coords.map(([x, yy]) => `L${x.toFixed(2)},${yy.toFixed(2)}`).join(" ") +
    ` L${VIEW_W},${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#fill-${gid})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
