/**
 * Seamless world sharding — the strip-grid geometry, ported faithfully from SKYDINSE's
 * TMregion `serverlogic.sk` (studied read-only on the live CloudNet host). The world's X axis
 * is split into vertical strips; each ordered running instance of a sharded task owns one strip.
 * Every instance renders the SAME full vanilla world border (so players see one continuous
 * world) but only "owns" its strip; crossing a boundary hands the player to the owning instance
 * keeping their exact position (same world seed everywhere ⇒ identical terrain ⇒ seamless).
 *
 * Overworld + End strips are `tol × 8` wide; the nether is `tol` (matching MC's 1:8 scale), so a
 * player walking the overworld and their nether counterpart cross boundaries at the same servers.
 */
import type { Sharding } from "./store";

const WORLD_EDGE = 3749998; // vanilla world border max half-extent

export type Strip = { min: number; max: number };
export type RegionWorlds = { world: Strip; world_nether: Strip; world_the_end?: Strip };
export type ShardRegion = {
  serverId: string; // connector identity, e.g. "network-world-202"
  target: string;   // velocity server name for transfers, e.g. "world-202"
  name: string;     // human label
  index: number;    // 1-based order (strip assignment)
  vmid: number;
  worlds: RegionWorlds;
};
export type ShardGrid = {
  world: string;
  tol: number;
  splitEnd: boolean;
  cancelRange: number;
  center: { x: number; z: number };
  /** full world-border diameters (every instance sets these) */
  border: { world: number; world_nether: number; world_the_end?: number };
  regions: ShardRegion[];
};

/** A region instance, in strip order. */
export type ShardMember = { serverId: string; target: string; name: string; vmid: number };

/** east = even index, west = odd index (matches serverlogic.sk mod-2 split). */
function isOuter(index: number, n: number): "east" | "west" | "no" {
  if (index >= n - 1) return index % 2 === 0 ? "east" : "west";
  return "no";
}

/** count of servers before `index` (1-based) on the given side. */
function serversBefore(side: "east" | "west", index: number): number {
  let c = 0;
  for (let i = 1; i < index; i++) {
    if (side === "east" && i % 2 === 0) c++;
    else if (side === "west" && i % 2 !== 0) c++;
  }
  return c;
}

/**
 * Compute the full strip grid for an ordered list of region instances.
 * `members` must be in a stable order (we sort callers by vmid) — strip assignment depends on it.
 */
export function computeShardGrid(cfg: Sharding, members: ShardMember[]): ShardGrid {
  const tol = Math.max(1, Math.round(cfg.stripWidth));
  const n = members.length;
  const baseMin = -(tol / 2);
  const baseMax = tol / 2;

  const regions: ShardRegion[] = members.map((m, i) => {
    const index = i + 1; // 1-based
    const outer = isOuter(index, n);
    let nMin: number, nMax: number;

    if (index % 2 === 0) {
      // east
      nMin = baseMin + tol * (serversBefore("east", index) + 1);
      nMax = outer === "no" ? baseMax + tol * serversBefore("west", index)
           : outer === "east" ? WORLD_EDGE : -WORLD_EDGE;
    } else {
      // west
      nMax = baseMax - tol * serversBefore("west", index);
      nMin = outer === "no" ? baseMin - tol * serversBefore("east", index)
           : outer === "east" ? WORLD_EDGE : -WORLD_EDGE;
    }

    const worlds: RegionWorlds = {
      world_nether: { min: nMin, max: nMax },
      world: { min: nMin * 8, max: nMax * 8 },
    };
    if (cfg.splitEnd) worlds.world_the_end = { min: nMin * 8, max: nMax * 8 };

    return { serverId: m.serverId, target: m.target, name: m.name, index, vmid: m.vmid, worlds };
  });

  const centerX = n % 2 === 0 ? tol / 2 : 0;
  const border: ShardGrid["border"] = {
    world: tol * 8 * Math.max(1, n),
    world_nether: tol * Math.max(1, n),
  };
  if (cfg.splitEnd) border.world_the_end = tol * 8 * Math.max(1, n);

  return {
    world: cfg.world || "world",
    tol,
    splitEnd: cfg.splitEnd,
    cancelRange: cfg.borderCancelRange,
    center: { x: centerX, z: 0 },
    border,
    regions,
  };
}

/** Which region owns a given X in a given world (the strip containing x). */
export function regionForX(grid: ShardGrid, world: string, x: number): ShardRegion | null {
  for (const r of grid.regions) {
    const strip = (r.worlds as Record<string, Strip | undefined>)[world];
    if (strip && x >= strip.min && x <= strip.max) return r;
  }
  return null;
}

export const DEFAULT_SHARDING: Sharding = {
  enabled: false,
  world: "world",
  stripWidth: 5000,
  splitEnd: true,
  borderCancelRange: 30,
};
