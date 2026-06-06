/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * This is where conduitd's reconcile loop lives: every tick it drives Proxmox
 * towards the desired state in the store. Same engine a standalone daemon would
 * call; here it just rides along in the dashboard process.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.CONDUIT_CONTROLLER === "off") return;

  const { reconcileAll } = await import("./lib/engine");

  const INTERVAL = Number(process.env.CONDUIT_INTERVAL_MS ?? 10_000);
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const log = await reconcileAll();
      const acted = log.filter((l) => !l.startsWith("skip"));
      if (acted.length) console.log("[conduitd]", acted.join(" | "));
    } catch (e) {
      console.error("[conduitd] tick failed:", e);
    } finally {
      running = false;
    }
  };

  console.log(`[conduitd] controller started — reconcile every ${INTERVAL}ms`);
  setInterval(tick, INTERVAL);
}
