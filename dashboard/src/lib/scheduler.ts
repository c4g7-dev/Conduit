/**
 * Recurring-schedule runner. Invoked from the leader controller tick (instrumentation.ts)
 * so it only ever runs on the VIP holder — never double-executes across the HA panels.
 *
 * Each schedule has a daily `at` (HH:MM) and a fine-grained target (group / subgroup / service /
 * instance). Actions: restart (with `say` warnings at `at - warnMins`, and optional
 * restart-on-empty deferral), command (run a console command), backup (vzdump). The action is
 * deduped per day+minute via the persisted `lastRun`; warnings are deduped in-memory.
 */
import { getDB, mutate, type Schedule, type ScheduleTarget } from "./store";
import { broadcastToTarget, restartTarget, restartInstance, backupTarget } from "./ops";
import { connServersByVmid } from "./metrics-source";
import { pushEvent } from "./events";

declare global {
  // eslint-disable-next-line no-var
  var __conduitWarnFired: Set<string> | undefined;
  // deferred restart-on-empty: vmid → why it's pending (cleared once restarted or expired)
  // eslint-disable-next-line no-var
  var __conduitPendingRestart: Map<number, { name: string; since: number }> | undefined;
}
if (!global.__conduitWarnFired) global.__conduitWarnFired = new Set();
if (!global.__conduitPendingRestart) global.__conduitPendingRestart = new Map();
const warnFired = global.__conduitWarnFired;
const pending = global.__conduitPendingRestart;

const pad = (n: number) => String(n).padStart(2, "0");

function minus(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  let t = h * 60 + m - mins;
  t = ((t % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** Back-compat: prefer `targets[]`, else single `target`, else legacy `groupId`. */
function targetsOf(s: Schedule): ScheduleTarget[] {
  if (s.targets?.length) return s.targets;
  if (s.target) return [s.target];
  return [{ type: "group", id: s.groupId ?? "" }];
}

function targetLabel(ts: ScheduleTarget[]): string {
  if (ts.length > 1) return `${ts.length} targets`;
  const t = ts[0];
  switch (t.type) {
    case "group": return `group ${t.id}`;
    case "subgroup": return `subgroup ${t.id}`;
    case "task": return `service ${t.id}`;
    case "instance": return `instance #${t.vmid}`;
  }
}

export async function runSchedules(): Promise<void> {
  // First, drain deferred restart-on-empty: restart any pending instance that's now empty.
  if (pending.size) {
    const players = connServersByVmid();
    for (const [vmid, info] of [...pending]) {
      if (Date.now() - info.since > 86_400_000) { pending.delete(vmid); continue; } // expire after a day
      if ((players.get(vmid)?.online ?? 0) === 0) {
        pending.delete(vmid);
        restartInstance(vmid)
          .then(() => pushEvent(`deferred restart "${info.name}" → instance #${vmid} emptied, restarted`, "warn"))
          .catch((e) => pushEvent(`! deferred restart #${vmid}: ${String(e)}`, "error"));
      }
    }
  }

  const db = await getDB();
  const schedules = db.schedules ?? [];
  if (!schedules.length) return;

  const now = new Date();
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const minute = `${day} ${hhmm}`;

  for (const s of schedules) {
    if (!s.enabled) continue;
    const target = targetsOf(s);

    // Pre-action warnings (restart only).
    if (s.action === "restart") {
      for (const w of s.warnMins ?? []) {
        if (minus(s.at, w) === hhmm) {
          const key = `${s.id}:${w}:${minute}`;
          if (!warnFired.has(key)) {
            warnFired.add(key);
            broadcastToTarget(target, `say [Conduit] Restart in ${w} minute${w === 1 ? "" : "s"}`).catch(() => {});
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
          const r = await restartTarget(target, s.onlyWhenEmpty);
          for (const vmid of r.deferred) pending.set(vmid, { name: s.name, since: Date.now() });
          if (r.restarted.length) broadcastToTarget(target, "say [Conduit] Restarting now").catch(() => {});
          pushEvent(
            `scheduled restart "${s.name}" (${targetLabel(target)}) → ${r.restarted.length}/${r.total} now`
            + (r.deferred.length ? `, ${r.deferred.length} deferred until empty` : ""),
            "warn",
          );
        } else if (s.action === "backup") {
          const r = await backupTarget(target, s.backupStorage ?? "local");
          pushEvent(`scheduled backup "${s.name}" (${targetLabel(target)}) → ${r.sent}/${r.total} instance(s)`);
        } else {
          // command / broadcast — run the console command on the target
          const r = await broadcastToTarget(target, s.command ?? "");
          pushEvent(`scheduled ${s.action} "${s.name}" (${targetLabel(target)}) → ${r.sent}/${r.total} server(s)`);
        }
      } catch (e) {
        pushEvent(`! schedule "${s.name}" failed: ${String(e)}`, "error");
      }
    }
  }

  if (warnFired.size > 500) warnFired.clear();
}

export type { Schedule };
