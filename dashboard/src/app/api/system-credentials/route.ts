/**
 * System-service credentials (Redis player-sync + Postgres/LuckPerms) — view + rotate.
 * These are sensitive, so GET requires ?reveal=1 (the UI gates it behind an explicit unlock).
 * Rotating writes a password override to the network record; the reconcile re-applies it to the
 * DB instances and every consumer (connectors via heartbeat config, LuckPerms config) picks the
 * new secret up — so creds stay in sync everywhere they're used.
 */
import { NextRequest, NextResponse } from "next/server";
import { mutate } from "@/lib/store";
import { redisPassword, getRedisCluster, REDIS_PORT } from "@/lib/redis-cluster";
import { pgPassword, getPgCluster, PG_USER, PG_DB, PG_PORT } from "@/lib/pg-cluster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const reveal = req.nextUrl.searchParams.get("reveal") === "1";
  const redis = getRedisCluster();
  const pg = getPgCluster();
  const [rpw, ppw] = await Promise.all([redisPassword(), pgPassword()]);
  const mask = (s: string) => (reveal ? s : "•".repeat(12));
  return NextResponse.json({
    redis: {
      user: "default",
      password: mask(rpw),
      endpoint: redis?.primary ? `${redis.primary.ip}:${REDIS_PORT}` : null,
      replicas: redis ? Math.max(0, redis.endpoints.length - 1) : 0,
      uses: "seamless-world player-data sync · LuckPerms messaging",
    },
    postgres: {
      user: PG_USER,
      database: PG_DB,
      password: mask(ppw),
      endpoint: pg?.primary ? `${pg.primary.ip}:${PG_PORT}` : null,
      uses: "LuckPerms storage",
    },
    revealed: reveal,
  });
}

/** Rotate a system credential. { service: "redis" | "postgres", password?: string }
 *  (omit password → generate a strong random one). The reconcile applies it cluster-wide. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const service = b.service === "postgres" ? "postgres" : b.service === "redis" ? "redis" : null;
    if (!service) return NextResponse.json({ error: "service must be redis or postgres" }, { status: 400 });
    const pw = typeof b.password === "string" && b.password.trim().length >= 8
      ? b.password.trim()
      : (await import("crypto")).randomBytes(18).toString("base64url").slice(0, 24);

    await mutate((d) => {
      d.network ??= { forwardingSecret: "" };
      if (service === "redis") d.network.redisPasswordOverride = pw;
      else d.network.pgPasswordOverride = pw;
    });
    // kick the reconcile so the new password is applied + propagated promptly
    const { reconcileAll } = await import("@/lib/engine");
    reconcileAll().catch(() => {});
    return NextResponse.json({ ok: true, service });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
