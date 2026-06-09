/**
 * Redis cluster discovery for seamless-world player-data sync. Redis runs as a normal Conduit
 * task (kind "redis"); the controller designates the lowest-vmid running instance as primary and
 * the rest as replicas, and publishes the live endpoint list (primary first) here. Connectors
 * pull it via the heartbeat config and fail over down the list, so spinning up / losing a Redis
 * instance is picked up automatically — no hardcoded address anywhere.
 */
import { createHash } from "crypto";
import { getNetwork } from "./store";

export const REDIS_PORT = 6379;

/** Deterministic Redis auth derived from the network secret (both panel & connector compute it). */
export async function redisPassword(): Promise<string> {
  const net = await getNetwork();
  return createHash("sha256").update(`${net.forwardingSecret}:conduit-redis`).digest("hex").slice(0, 32);
}

export type RedisCluster = {
  primary: { vmid: number; ip: string } | null;
  endpoints: string[]; // "ip:port", primary first
  password: string;
  updatedAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __conduitRedis: RedisCluster | undefined;
}

/** Publish the current Redis cluster (called by the controller reconcile loop). */
export function setRedisCluster(c: RedisCluster) { global.__conduitRedis = c; }

/** The last-published Redis cluster (read by the connector heartbeat config builder). */
export function getRedisCluster(): RedisCluster | null { return global.__conduitRedis ?? null; }
