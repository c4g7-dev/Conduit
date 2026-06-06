/**
 * Tiny JSON-file store for Conduit's desired state (groups + tasks).
 * The controller reconciles Proxmox reality towards what's written here.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Seed } from "./blueprints";

export type Group = {
  id: string; // kebab, also the Proxmox pool id
  name: string;
  slotLimit: number;
  maintenance: boolean;
  createdAt: number;
};

export type Task = {
  id: string; // kebab, unique
  name: string;
  groupId: string;
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
  createdAt: number;
};

/** Network-wide settings shared by all instances (e.g. proxy↔backend secret). */
export type Network = { forwardingSecret: string };

export type DB = { groups: Group[]; tasks: Task[]; network?: Network };

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "conduit.json");

let cache: DB | null = null;
let writing: Promise<void> = Promise.resolve();

async function ensure(): Promise<DB> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    cache = JSON.parse(raw) as DB;
  } catch {
    cache = { groups: [], tasks: [] };
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(cache, null, 2));
  }
  return cache;
}

export async function getDB(): Promise<DB> {
  return ensure();
}

export async function saveDB(db: DB): Promise<void> {
  cache = db;
  // serialize writes so concurrent reconciles don't clobber each other
  writing = writing.then(async () => {
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
