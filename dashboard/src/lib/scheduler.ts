/**
 * Recurring-schedule runner. Invoked from the leader controller tick (instrumentation.ts)
 * so it only ever runs on the VIP holder — never double-executes across the HA panels.
 *
 * Semantics: each schedule has a daily `at` (HH:MM). `restart` schedules also fire `say`
 * warnings at `at - warnMins`. The action is deduped per day+minute via the persisted
 * `lastRun`; warnings are deduped in-memory (harmless if a failover re-sends one).
 */
import { getDB, mutate, type Schedule } from "./store";
import { broadcastToGroup, restartGroup } from "./ops";
import { pushEvent } from "./events";

declare global {
  // eslint-disable-next-line no-var
  var __conduitWarnFired: Set<string> | undefined;
}
if (!global.__conduitWarnFired) global.__conduitWarnFired = new Set();
const warnFired = global.__conduitWarnFired;

const pad = (n: number) => String(n).padStart(2, "0");

function minus(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  let t = h * 60 + m - mins;
  t = ((t % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

export async function runSchedules(): Promise<void> {
  const db = await getDB();
  const schedules = db.schedules ?? [];
  if (!schedules.length) return;

  const now = new Date();
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const minute = `${day} ${hhmm}`;

  for (const s of schedules) {
    if (!s.enabled) continue;

    // Pre-action warnings (restart only).
    if (s.action === "restart") {
      for (const w of s.warnMins ?? []) {
        if (minus(s.at, w) === hhmm) {
          const key = `${s.id}:${w}:${minute}`;
          if (!warnFired.has(key)) {
            warnFired.add(key);
            broadcastToGroup(s.groupId, `say [Conduit] Restart in ${w} minute${w === 1 ? "" : "s"}`).catch(() => {});
          }
        }
      }
    }

    // The action itself, once per day+minute.
    if (s.at === hhmm && s.lastRun !== minute) {
      await mutate((d) => {
        const live = (d.schedules ?? []).find((x) => x.id === s.id);
        if (live) live.lastRun = minute;
      }).catch(() => {});
      try {
        if (s.action === "restart") {
          await broadcastToGroup(s.groupId, "say [Conduit] Restarting now").catch(() => {});
          const r = await restartGroup(s.groupId);
          pushEvent(`scheduled restart "${s.name}" → ${r.sent}/${r.total} instance(s)`, "warn");
        } else {
          const r = await broadcastToGroup(s.groupId, s.command ?? "");
          pushEvent(`scheduled broadcast "${s.name}" → ${r.sent}/${r.total} server(s)`);
        }
      } catch (e) {
        pushEvent(`! schedule "${s.name}" failed: ${String(e)}`, "error");
      }
    }
  }

  // Keep the warn-dedup set from growing unbounded.
  if (warnFired.size > 500) warnFired.clear();
}

export type { Schedule };
