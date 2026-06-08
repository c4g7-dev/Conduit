/**
 * In-memory event log + derived health alerts for the Activity page.
 * Stored on a Node global so it survives Next.js hot-reloads and is shared across
 * route handlers + the controller loop in one process.
 */
export type EventLevel = "info" | "warn" | "error";
export type ConduitEvent = { id: number; at: number; level: EventLevel; msg: string };

declare global {
  // eslint-disable-next-line no-var
  var __conduitEvents: ConduitEvent[] | undefined;
  // eslint-disable-next-line no-var
  var __conduitEventSeq: number | undefined;
}
if (!global.__conduitEvents) global.__conduitEvents = [];
if (global.__conduitEventSeq === undefined) global.__conduitEventSeq = 0;

const MAX = 300;
const log = global.__conduitEvents;

/** Classify a reconcile log line into a level for nicer rendering. */
function levelFor(msg: string): EventLevel {
  if (msg.startsWith("!") || /fail|error/i.test(msg)) return "error";
  if (msg.startsWith("-") || /destroy|gc |kick|down|unreachable/i.test(msg)) return "warn";
  return "info";
}

export function pushEvent(msg: string, level?: EventLevel) {
  const ev: ConduitEvent = {
    id: ++global.__conduitEventSeq!,
    at: Date.now(),
    level: level ?? levelFor(msg),
    msg,
  };
  log.push(ev);
  if (log.length > MAX) log.splice(0, log.length - MAX);
  return ev;
}

/** Record a batch of reconcile log lines (skips the noisy "skip:" lines). */
export function recordReconcile(lines: string[]) {
  for (const l of lines) {
    if (l.startsWith("skip")) continue;
    pushEvent(l);
  }
}

export function getEvents(sinceId = 0): ConduitEvent[] {
  return sinceId ? log.filter((e) => e.id > sinceId) : log.slice();
}
