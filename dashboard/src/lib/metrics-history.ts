/**
 * Lightweight server-side history for metrics Proxmox RRD doesn't track — player count and live
 * container count. Sampled into per-minute buckets (the reconcile loop records each tick, and a
 * GET records opportunistically), kept ~30d. We then align these to the RRD timestamps so the
 * unified metrics panel can plot players/containers alongside cpu/mem over any range.
 *
 * In-memory on a Node global (shared across module instances). CPU/mem persist in Proxmox RRD;
 * this players/containers series resets on a panel restart (acceptable — it refills as it samples).
 */
type Bucket = { players: number; containers: number; perVmid?: Record<number, number> };
declare global { var __conduitMetricsHist: Map<number, Bucket> | undefined; }
const hist = (global.__conduitMetricsHist ??= new Map<number, Bucket>());

const MINUTE = 60_000;
const MAX_AGE = 31 * 24 * 60 * MINUTE; // ~31 days

/** Record the current player + container counts (and per-vmid players) into this minute's bucket. */
export function recordMetrics(players: number, containers: number, perVmid?: Record<number, number>) {
  const m = Math.floor(Date.now() / MINUTE);
  hist.set(m, { players, containers, perVmid });
  if (hist.size > 50_000) {
    const cutoff = Math.floor((Date.now() - MAX_AGE) / MINUTE);
    for (const k of hist.keys()) if (k < cutoff) hist.delete(k);
  }
}

/** For each timestamp (ms), the last-known players/containers at or before it (0 if none yet). */
export function seriesAt(timestampsMs: number[]): { players: number; containers: number }[] {
  const minutes = [...hist.keys()].sort((a, b) => a - b);
  return timestampsMs.map((tms) => {
    const target = Math.floor(tms / MINUTE);
    let best: Bucket | undefined;
    for (const mm of minutes) { if (mm <= target) best = hist.get(mm); else break; }
    return { players: best?.players ?? 0, containers: best?.containers ?? 0 };
  });
}

/** Per-vmid player count aligned to each timestamp (last-known ≤ t). */
export function seriesAtVmid(timestampsMs: number[], vmid: number): number[] {
  const minutes = [...hist.keys()].sort((a, b) => a - b);
  return timestampsMs.map((tms) => {
    const target = Math.floor(tms / MINUTE);
    let best: Bucket | undefined;
    for (const mm of minutes) { if (mm <= target) best = hist.get(mm); else break; }
    return best?.perVmid?.[vmid] ?? 0;
  });
}
