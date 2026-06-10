/**
 * PostgreSQL discovery for the permissions backend (LuckPerms). Postgres runs as a normal
 * Conduit task (kind "postgres"); the controller publishes the lowest-vmid running instance
 * here, and both the panel (LuckPerms editor/status) and the LuckPerms installer read it —
 * no hardcoded address anywhere. Auth derives from the network secret like Redis.
 */
import { createHash } from "crypto";
import { getNetwork } from "./store";

export const PG_PORT = 5432;
export const PG_USER = "conduit";
export const PG_DB = "luckperms";

/** Deterministic Postgres auth derived from the network secret. */
export async function pgPassword(): Promise<string> {
  const net = await getNetwork();
  return createHash("sha256").update(`${net.forwardingSecret}:conduit-postgres`).digest("hex").slice(0, 32);
}

export type PgCluster = {
  primary: { vmid: number; ip: string } | null;
  updatedAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __conduitPg: PgCluster | undefined;
}

/** Publish the current Postgres primary (called by the controller reconcile loop). */
export function setPgCluster(c: PgCluster) { global.__conduitPg = c; }

/** The last-published Postgres primary (panel LuckPerms link + installer). */
export function getPgCluster(): PgCluster | null { return global.__conduitPg ?? null; }
