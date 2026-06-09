/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * This is where conduitd's reconcile loop lives: every tick it drives Proxmox
 * towards the desired state in the store. Same engine a standalone daemon would
 * call; here it just rides along in the dashboard process.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.CONDUIT_CONTROLLER === "off") return;

  const os = await import("node:os");
  const { reconcileAll } = await import("./lib/engine");
  const { loadEvents, flushEvents } = await import("./lib/events");
  // Restore the persisted audit log into memory on boot (survives restart/rebuild).
  await loadEvents().catch(() => {});

  const INTERVAL = Number(process.env.CONDUIT_INTERVAL_MS ?? 10_000);
  // Leader election: when a VIP is configured (HA panel-per-node), only the instance
  // currently holding the VIP reconciles. On failover the new VIP holder takes over
  // automatically; backups stay warm but passive. No VIP set → always the leader (dev).
  const VIP = process.env.CONDUIT_VIP ?? "";
  let running = false;
  let wasLeader: boolean | null = null;

  const holdsVip = (): boolean => {
    if (!VIP) return true;
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const a of addrs ?? []) {
        if (a.address === VIP) return true;
      }
    }
    return false;
  };

  const tick = async () => {
    const leader = holdsVip();
    if (leader !== wasLeader) {
      console.log(`[conduitd] ${leader ? "this node holds the VIP — assuming leadership" : "VIP not local — standing by as passive backup"}`);
      wasLeader = leader;
    }
    if (!leader || running) return;
    running = true;
    try {
      const log = await reconcileAll();
      const acted = log.filter((l) => !l.startsWith("skip"));
      if (acted.length) console.log("[conduitd]", acted.join(" | "));
      // Run due scheduled actions — leader-only, so they never double-fire.
      const { runSchedules } = await import("./lib/scheduler");
      await runSchedules().catch((e) => console.error("[conduitd] schedules:", e));
      // Persist the audit log to the shared store (only flushes if it changed).
      await flushEvents().catch(() => {});
    } catch (e) {
      console.error("[conduitd] tick failed:", e);
    } finally {
      running = false;
    }
  };

  console.log(
    `[conduitd] controller started — reconcile every ${INTERVAL}ms` +
      (VIP ? ` (leader-gated on VIP ${VIP})` : ""),
  );
  setInterval(tick, INTERVAL);
}
