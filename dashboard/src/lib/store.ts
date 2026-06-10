/**
 * Store for Conduit's desired state (groups + tasks).
 * The controller reconciles Proxmox reality towards what's written here.
 *
 * Two backends, same public API (getDB/saveDB/mutate/getNetwork):
 *   - "file" (default): local JSON at cwd/data/conduit.json — dev on a workstation.
 *   - "agent": read/write via a node agent's /v1/state, which persists to the
 *     corosync-replicated /etc/pve/conduit/conduit.json so every panel LXC shares
 *     one consistent, quorum-backed copy. Enabled with CONDUIT_STATE_BACKEND=agent
 *     + CONDUIT_STATE_AGENT=<host>.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Seed, Software, Blueprint } from "./blueprints";
import { agentGetState, agentPutState } from "./agent";

export type Group = {
  id: string; // kebab, also the Proxmox pool id
  name: string;
  slotLimit: number;
  maintenance: boolean;
  /** named sub-buckets of tasks (Untergruppen) — addressable for maintenance/ops */
  subgroups?: Subgroup[];
  createdAt: number;
};

/**
 * A subgroup (Untergruppe) separates a group's tasks into addressable units, so ops like
 * maintenance can target e.g. just `timesmp` inside the main network group. Tasks opt in
 * via Task.subgroupId; tasks without one belong to the group directly (back-compat).
 */
export type Subgroup = {
  id: string; // kebab, unique within the group
  name: string;
  maintenance: boolean;
  createdAt: number;
};

export type Task = {
  id: string; // kebab, unique
  name: string;
  groupId: string;
  /** optional subgroup (Untergruppe) within the group this task belongs to */
  subgroupId?: string;
  /** per-task maintenance: the proxy denies connecting to this task's servers
   *  (bypass via conduit.maintenance.bypass[.<task>]); subgroup maintenance cascades here */
  maintenance?: boolean;
  blueprintId: string;
  mode: "dynamic" | "static";
  /** desired live instance count; controller drives reality to this (manual mode) */
  desired: number;
  min: number;
  max: number; // 0 = unbounded
  /** when true the controller computes `desired` from live player load (lobbies) */
  autoscale: boolean;
  playersPerInstance: number;
  cores: number;
  memory: number;
  disk: number;
  persistent: boolean;
  /** for proxy-role tasks: ids of tasks this proxy fronts */
  fronts: string[];
  /** optional per-task seed overrides, merged over the blueprint's seed */
  seed?: Seed;
  /** optional per-task software/version override (e.g. a different MC version) */
  software?: Software;
  /** server list MOTD (supports & colour codes); applied to this task's instances */
  motd?: string;
  /** for dynamic tasks: the golden template CT (stopped) that scale-ups clone from */
  templateVmid?: number;
  /* ---- CloudNet Smart-style autoscaling knobs (optional; sane defaults applied) ---- */
  /** pre-cloned, stopped instances kept ready for instant scale-up (CloudNet preparedServices) */
  preparedPool?: number;
  /** scale up when any live server exceeds this % of playersPerInstance (default 100) */
  scaleUpPercent?: number;
  /** only scale down an empty instance after it's been idle this long (seconds, default 60) */
  scaleDownAfterSec?: number;
  /** minimum seconds between spawning new instances (default 5) */
  spawnCooldownSec?: number;
  /** hard cap on instances (alias for max; 0 = unbounded) */
  maxServices?: number;
  /** spread instances across nodes rather than packing one node */
  splitOverNodes?: boolean;
  /** preferred Proxmox node for this task's instances (undefined = auto / least-loaded) */
  node?: string;
  /** opt-in seamless multi-server world (TMregion-style X-strip sharding); default off */
  sharding?: Sharding;
  createdAt: number;
};

/**
 * Seamless world sharding (opt-in). The task's ordered running instances each own one
 * vertical X-strip of a shared world; players cross strip boundaries and are handed off to
 * the owning instance keeping their exact position. Mirrors SKYDINSE's TMregion serverlogic.
 */
export type Sharding = {
  enabled: boolean;
  /** base overworld name in the container (default "world"; nether/end derived) */
  world: string;
  /** nether strip width `tol` (blocks); overworld + end strips are tol×8 */
  stripWidth: number;
  /** also shard the End (overworld-scaled) */
  splitEnd: boolean;
  /** seam no-build buffer: cancel block interaction within this many blocks of a boundary */
  borderCancelRange: number;
  /** shared world seed — ALL region instances must generate with the same seed so the terrain
   *  is continuous across strips (different seeds = teleporting to the same X/Z lands in
   *  different terrain). Auto-assigned when sharding is enabled; applied via level-seed. */
  seed?: string;
};

/** Golden-image build status per egg: which node holds the template CT, version, timestamp. */
export type ImageStatus = {
  eggId: string;
  templates: Record<string, number>; // node → template vmid
  version: number;
  builtAt: number;
  building?: boolean;
  error?: string;
};

/** Network-wide settings shared by all instances (e.g. proxy↔backend secret). */
export type Network = { forwardingSecret: string };

/** A recurring scheduled action against a group (run by the leader controller). */
export type Schedule = {
  id: string;
  name: string;
  groupId: string;
  action: "restart" | "broadcast";
  at: string; // "HH:MM" 24h, daily
  command?: string; // for broadcast
  warnMins: number[]; // pre-action `say` warnings (restart), e.g. [5, 1]
  enabled: boolean;
  lastRun?: string; // "YYYY-MM-DD HH:MM" of the last action run (dedup)
};

export type DB = {
  groups: Group[];
  tasks: Task[];
  network?: Network;
  /** user-created templates, merged with the built-in blueprints */
  blueprints?: Blueprint[];
  /** recurring scheduled actions (restarts, broadcasts) */
  schedules?: Schedule[];
  /** golden-image build status per egg (for fast clone-based autoscaling) */
  images?: ImageStatus[];
};

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "conduit.json");

const STATE_BACKEND = process.env.CONDUIT_STATE_BACKEND ?? "file";
const STATE_AGENT = process.env.CONDUIT_STATE_AGENT ?? "";
const useAgentState = STATE_BACKEND === "agent" && STATE_AGENT.length > 0;

let cache: DB | null = null;
let writing: Promise<void> = Promise.resolve();

function normalize(db: Partial<DB> | null | undefined): DB {
  return {
    groups: db?.groups ?? [],
    tasks: db?.tasks ?? [],
    network: db?.network,
    blueprints: db?.blueprints,
    schedules: db?.schedules,
    images: db?.images,
  };
}

/**
 * Always read fresh state. Next.js can run instrumentation (the controller loop)
 * and route handlers in separate module instances, so an in-memory cache goes stale
 * across them. Reading the source each call keeps every instance consistent;
 * `cache` is only a last-resort fallback when the source is unreachable.
 */
async function ensure(): Promise<DB> {
  if (useAgentState) {
    try {
      cache = normalize(await agentGetState<Partial<DB>>(STATE_AGENT));
      return cache;
    } catch {
      if (cache) return cache;
      cache = normalize(null);
      return cache;
    }
  }
  try {
    const raw = await fs.readFile(FILE, "utf8");
    cache = JSON.parse(raw) as DB;
    return cache;
  } catch {
    if (cache) return cache;
    cache = normalize(null);
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(cache, null, 2));
    return cache;
  }
}

export async function getDB(): Promise<DB> {
  return ensure();
}

export async function saveDB(db: DB): Promise<void> {
  cache = db;
  // serialize writes so concurrent reconciles don't clobber each other
  writing = writing.then(async () => {
    if (useAgentState) {
      await agentPutState(STATE_AGENT, db);
      return;
    }
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(db, null, 2));
  });
  return writing;
}

export async function mutate<T>(fn: (db: DB) => T): Promise<T> {
  const db = await ensure();
  const result = fn(db);
  await saveDB(db);
  return result;
}

/** The network's Velocity modern-forwarding secret, generated once and persisted. */
export async function getNetwork(): Promise<Network> {
  const db = await ensure();
  if (!db.network?.forwardingSecret) {
    db.network = { forwardingSecret: crypto.randomBytes(16).toString("hex") };
    await saveDB(db);
  }
  return db.network;
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}
