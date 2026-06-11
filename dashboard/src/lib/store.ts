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
  /** network player cap — ENFORCED at the proxy login (cheap deny, no backend connect) */
  slotLimit: number;
  /** custom kick message shown when the network is full (legacy & colors) */
  fullMessage?: string;
  maintenance: boolean;
  /** named sub-buckets of tasks (Untergruppen) — addressable for maintenance/ops; nestable */
  subgroups?: Subgroup[];
  createdAt: number;
};

/**
 * A subgroup (Untergruppe) separates a group's tasks into addressable units, so ops like
 * maintenance can target e.g. just `timesmp` inside the main network group. Tasks opt in
 * via Task.subgroupId; tasks without one belong to the group directly (back-compat).
 * Subgroups nest via parentId (a subgroup of a subgroup) — maintenance and slot limits
 * cascade down the chain.
 */
export type Subgroup = {
  id: string; // kebab, unique within the group
  name: string;
  /** parent subgroup id (same group) — undefined = top-level under the group */
  parentId?: string;
  maintenance: boolean;
  /** player cap across this subgroup's servers (incl. nested) — 0/undefined = unlimited.
   *  Enforced by the proxy on connect with a custom message. */
  slotLimit?: number;
  /** custom deny message when the subgroup is full (legacy & colors) */
  fullMessage?: string;
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
  /** for proxy-role tasks: ordered fallback "try" list (task ids; subset of fronts).
   *  Players land on the first live entry — put Limbo last as the catch-all. When unset,
   *  the lobby-role fronted tasks are used in fronts order. */
  tryOrder?: string[];
  /** optional per-task seed overrides, merged over the blueprint's seed */
  seed?: Seed;
  /** optional per-task software/version override (e.g. a different MC version) */
  software?: Software;
  /** auto-apply hotfixes (new BUILDS of the pinned version line) — never a new full version */
  autoUpdate?: boolean;
  /** version PIN: deliberately locked to its current version — the panel stops nudging about
   *  newer full versions (mutes the upgrade banner/badge); upgrading still works explicitly */
  pinned?: boolean;
  /** rewrite-on-change: when the overlay chain (global/egg/task files) changes, re-apply it to
   *  running instances — keeps static services in sync with their template */
  templateSync?: boolean;
  /** whether auto file-sync also RESTARTS the instance on change (default off: files re-applied,
   *  picked up on the next natural restart so players aren't kicked) */
  templateSyncRestart?: boolean;
  /** last overlay-chain signature applied by auto file-sync — PERSISTED so panel restarts
   *  don't silently absorb overlay edits as a fresh baseline */
  templateSyncSig?: string;
  /** newest upstream build installed across this task's instances (hotfix tracking) */
  installedBuild?: number;
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
export type Network = {
  forwardingSecret: string;
  /** player-audit retention in days (DSGVO) — older day files are purged; default 30 */
  auditRetentionDays?: number;
  /** task ids that should ALWAYS have LuckPerms installed (reconcile keeps them in sync) */
  luckpermsTasks?: string[];
  /** task ids that should have the Conduit connector — undefined = all paper/velocity/hytale
   *  (default behaviour); set to opt specific services out/in */
  connectorTasks?: string[];
  /** rotatable system-service credential overrides (else derived from forwardingSecret).
   *  Bumping these rotates Redis / Postgres passwords and re-syncs every consumer. */
  redisPasswordOverride?: string;
  pgPasswordOverride?: string;
  /** cross-service inventory sharing: named groups of MC services that share player inventory
   *  (HP/XP/effects) via Redis — beyond a single sharded world's instances. */
  invShareGroups?: { id: string; name: string; taskIds: string[] }[];
};

/** What a schedule acts on — a whole group, one subgroup (incl. nested), a service, or a
 *  single instance. Replaces the old group-only target; `Schedule.groupId` stays for back-compat. */
export type ScheduleTarget =
  | { type: "group"; id: string }
  | { type: "subgroup"; groupId: string; id: string }
  | { type: "task"; id: string }
  | { type: "instance"; vmid: number };

/** A recurring scheduled action (run by the leader controller). */
export type Schedule = {
  id: string;
  name: string;
  /** legacy group-only target — old schedules; new ones use `targets` */
  groupId?: string;
  /** legacy single target (kept readable for back-compat; superseded by `targets`) */
  target?: ScheduleTarget;
  /** fine-grained targets (any mix of groups / subgroups / services / instances; deduped) */
  targets?: ScheduleTarget[];
  action: "restart" | "command" | "broadcast" | "backup";
  at: string; // "HH:MM" 24h, daily
  command?: string; // for command/broadcast
  warnMins: number[]; // pre-action `say` warnings (restart), e.g. [5, 1]
  /** restart only when the target is empty — occupied instances are deferred until they empty */
  onlyWhenEmpty?: boolean;
  /** storage for the backup action (vzdump) */
  backupStorage?: string;
  enabled: boolean;
  lastRun?: string; // "YYYY-MM-DD HH:MM" of the last action run (dedup)
};

/**
 * A named, generic file template shared across explicitly-chosen services (ideas.md §2). Unlike
 * the per-egg overlay or the kind-wide _global/<kind> layer, membership is hand-picked: pick any
 * tasks and they all receive this template's files. Files live at overlays/_tpl/<id>/ on the
 * shared store (file-manager / SFTP editable).
 */
export type GlobalTemplate = {
  id: string;       // kebab, unique
  name: string;
  taskIds: string[]; // member services
  createdAt: number;
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
  /** named generic file templates applied to hand-picked services */
  globalTemplates?: GlobalTemplate[];
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
    globalTemplates: db?.globalTemplates,
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
