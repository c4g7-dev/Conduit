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
  // last event id flushed to disk + load-once guard — on global so instrumentation and route
  // module instances (Next.js may load events.ts twice) share the same flush state.
  // eslint-disable-next-line no-var
  var __conduitFlushedId: number | undefined;
  // eslint-disable-next-line no-var
  var __conduitLoaded: boolean | undefined;
}
if (!global.__conduitEvents) global.__conduitEvents = [];
if (global.__conduitEventSeq === undefined) global.__conduitEventSeq = 0;
if (global.__conduitFlushedId === undefined) global.__conduitFlushedId = 0;

// Persisted to the shared (GlusterFS) store so the audit log survives panel restarts/rebuilds
// and is shared across the 3 panels. Kept bounded; flushed periodically (not per-event).
const MAX = 5000;
const STORE_PATH = "activity.json"; // relative to /var/lib/conduit
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

/** Load persisted events from the shared store into the in-memory ring (once, on startup). */
export async function loadEvents(): Promise<void> {
  if (global.__conduitLoaded) return;
  global.__conduitLoaded = true;
  try {
    const { fsRead } = await import("./agent");
    const { content } = await fsRead(STORE_PATH);
    const saved = JSON.parse(content) as ConduitEvent[];
    if (Array.isArray(saved) && saved.length) {
      // prepend persisted history (older) before anything captured this run
      log.unshift(...saved.filter((e) => !log.some((x) => x.id === e.id)));
      if (log.length > MAX) log.splice(0, log.length - MAX);
      const maxId = Math.max(global.__conduitEventSeq ?? 0, ...saved.map((e) => e.id));
      global.__conduitEventSeq = maxId;
      global.__conduitFlushedId = maxId; // already on disk
    }
  } catch { /* no persisted log yet — fine */ }
}

/** Flush the in-memory ring to the shared store if new events arrived (leader calls this). */
export async function flushEvents(): Promise<void> {
  const newest = log.length ? log[log.length - 1].id : 0;
  if (newest <= (global.__conduitFlushedId ?? 0)) return; // nothing new
  try {
    const { fsWrite } = await import("./agent");
    await fsWrite(STORE_PATH, JSON.stringify(log));
    global.__conduitFlushedId = newest;
  } catch { /* leave flushedId; retry next tick */ }
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
