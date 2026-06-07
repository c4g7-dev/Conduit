/**
 * In-memory ring buffer of recent metric samples.
 *
 * The Next.js server process is long-lived, so a module-level array persists
 * across requests. Samples are pushed by the Overview page (client-push) via
 * POST /api/metrics/history, and read back via GET. Dependency-free.
 */

export type Sample = {
  t: number; // epoch ms
  players: number;
  cpu: number; // 0..1
  mem: number; // 0..1
};

const CAP = 180;
const buffer: Sample[] = [];

export function pushSample(s: Sample): void {
  buffer.push(s);
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
}

export function getHistory(): Sample[] {
  return buffer;
}
