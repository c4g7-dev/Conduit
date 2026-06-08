// Shared trigger counters so the console SSE stream can refresh immediately
// after a command is sent, without waiting for the next polling interval.
// Uses a Node.js global to survive Next.js hot-reloads.
declare global {
  var __conduitConsoleTriggers: Map<number, number> | undefined;
}
if (!global.__conduitConsoleTriggers) global.__conduitConsoleTriggers = new Map();
export const consoleTriggers = global.__conduitConsoleTriggers;
