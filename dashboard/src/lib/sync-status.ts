/**
 * Live progress of template/overlay file syncs (manual re-sync + auto file-sync), so the UI can
 * show what's copying where with size + ETA. A sync = one task's overlay chain being pushed to
 * its running instances; each instance is tracked per node. Lives on a Node global so the leader
 * controller and the API route (possibly different Next module instances) share one view.
 */
export type SyncInstanceState = {
  vmid: number;
  node: string;
  status: "pending" | "copying" | "done" | "error";
  error?: string;
  /** ms when this instance started copying / finished (for per-instance timing) */
  startedAt?: number;
  finishedAt?: number;
};

export type SyncJob = {
  id: string;
  taskId: string;
  taskName: string;
  /** trigger: a manual re-sync vs the automatic on-change watcher */
  trigger: "manual" | "auto";
  /** restart instances after applying? */
  restart: boolean;
  /** total bytes + file count of the overlay chain (one instance's worth) */
  bytes: number;
  files: number;
  startedAt: number;
  finishedAt?: number;
  instances: SyncInstanceState[];
};

declare global {
  // eslint-disable-next-line no-var
  var __conduitSyncs: SyncJob[] | undefined;
}
const jobs = (global.__conduitSyncs ??= []);
const MAX = 40; // keep a short tail of finished jobs for the UI

export function startSync(j: Omit<SyncJob, "id" | "startedAt" | "finishedAt">): string {
  const id = `${j.taskId}-${Date.now().toString(36)}`;
  jobs.push({ ...j, id, startedAt: Date.now() });
  if (jobs.length > MAX) jobs.splice(0, jobs.length - MAX);
  return id;
}

export function updateSyncInstance(id: string, vmid: number, patch: Partial<SyncInstanceState>) {
  const job = jobs.find((x) => x.id === id);
  const inst = job?.instances.find((i) => i.vmid === vmid);
  if (inst) Object.assign(inst, patch);
}

export function finishSync(id: string) {
  const job = jobs.find((x) => x.id === id);
  if (job) job.finishedAt = Date.now();
}

/** Active jobs + finished ones from the last 60s (so a quick sync stays briefly visible). */
export function getSyncs(): SyncJob[] {
  const now = Date.now();
  return jobs.filter((j) => !j.finishedAt || now - j.finishedAt < 60_000);
}
