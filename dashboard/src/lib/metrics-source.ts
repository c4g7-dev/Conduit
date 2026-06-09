/**
 * Bridge the connector registry to per-instance metrics, keyed by vmid. The connector plugin
 * registers each service as `${taskId}-${vmid}` (see connectorEnv in provision.ts), so the
 * trailing number is the container vmid. This is the single source of player truth now that
 * SLP (mcping) is gone.
 */
import { liveServers, type ConnServer } from "./connector";

/** vmid → connector server record (only servers currently reporting). */
export function connServersByVmid(): Map<number, ConnServer> {
  const out = new Map<number, ConnServer>();
  for (const s of liveServers()) {
    const m = /-(\d+)$/.exec(s.id);
    if (m) out.set(Number(m[1]), s);
  }
  return out;
}
