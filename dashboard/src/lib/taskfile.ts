/**
 * Two-way sync between each task's definition and a human-editable YAML on the shared store:
 *   /var/lib/conduit/tasks/<id>/task.yaml
 *
 * - Export: whenever a task changes (GUI/API), the reconcile rewrites its task.yaml.
 * - Import: if a task.yaml is edited externally (SFTP / file manager) its mtime moves past
 *   our last write, so the engine parses it and applies the editable fields back to the
 *   store ("newer file wins"). Structural fields (id/group/blueprint) are read-only.
 * Stale dirs (tasks with no matching task) are removed.
 *
 * Runs only on the leader (reconcileAll is leader-gated), so there's a single writer.
 * Files live on the host gluster mount → driven via nodeExec (SSH to a PVE host).
 */
import yaml from "js-yaml";
import { nodeExec } from "./provision";
import { mutate, type DB, type Task } from "./store";

const TASKS_DIR = "/var/lib/conduit/tasks";

declare global {
  // eslint-disable-next-line no-var
  var __conduitTaskSync: Map<string, { yaml: string; at: number }> | undefined;
}
if (!global.__conduitTaskSync) global.__conduitTaskSync = new Map();
const syncState = global.__conduitTaskSync;

/** The editable view of a task that maps to/from YAML. */
function taskToObj(t: Task) {
  return {
    id: t.id,
    name: t.name,
    group: t.groupId,
    blueprint: t.blueprintId,
    mode: t.mode,
    min: t.min,
    max: t.max,
    desired: t.desired,
    autoscale: t.autoscale,
    playersPerInstance: t.playersPerInstance,
    cores: t.cores,
    memory: t.memory,
    disk: t.disk,
    persistent: t.persistent,
    fronts: t.fronts,
    version: t.software?.version ?? "",
    motd: t.motd ?? "",
  };
}

function serialize(t: Task): string {
  const header =
    "# Conduit task — edit values and save; changes apply on the next reconcile (~10s).\n" +
    "# id / group / blueprint are structural and ignored on edit.\n";
  return header + yaml.dump(taskToObj(t), { lineWidth: 120, noRefs: true });
}

/** Apply editable fields from a parsed YAML object onto a task. Returns true if anything changed. */
function applyObj(t: Task, o: Record<string, unknown>): boolean {
  let changed = false;
  const num = (v: unknown, cur: number) => (typeof v === "number" && Number.isFinite(v) ? v : cur);
  const set = <K extends keyof Task>(k: K, v: Task[K]) => { if (t[k] !== v) { t[k] = v; changed = true; } };

  if (typeof o.name === "string" && o.name.trim()) set("name", o.name.trim());
  if (o.mode === "dynamic" || o.mode === "static") set("mode", o.mode);
  set("min", Math.max(0, num(o.min, t.min)));
  set("max", Math.max(0, num(o.max, t.max)));
  set("autoscale", typeof o.autoscale === "boolean" ? o.autoscale : t.autoscale);
  set("playersPerInstance", Math.max(1, num(o.playersPerInstance, t.playersPerInstance)));
  set("cores", Math.max(1, num(o.cores, t.cores)));
  set("memory", Math.max(128, num(o.memory, t.memory)));
  set("disk", Math.max(1, num(o.disk, t.disk)));
  set("persistent", typeof o.persistent === "boolean" ? o.persistent : t.persistent);
  if (Array.isArray(o.fronts)) {
    const next = o.fronts.filter((x) => typeof x === "string");
    if (JSON.stringify(next) !== JSON.stringify(t.fronts)) { t.fronts = next as string[]; changed = true; }
  }
  if (typeof o.motd === "string") set("motd", o.motd);
  if (typeof o.version === "string" && o.version && o.version !== (t.software?.version ?? "")) {
    t.software = { kind: t.software?.kind ?? "", version: o.version } as Task["software"];
    changed = true;
  }
  // clamp desired into [min, max||∞]
  const wantDesired = num(o.desired, t.desired);
  const clamped = Math.max(t.min, t.max > 0 ? Math.min(wantDesired, t.max) : wantDesired);
  set("desired", clamped);
  return changed;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function writeFile(path: string, content: string): Promise<void> {
  await nodeExec(`mkdir -p "$(dirname '${path}')" && echo ${b64(content)} | base64 -d > '${path}'`, 20_000);
}

/**
 * Sync every task ⇄ its task.yaml and prune stale dirs.
 * Returns true if the in-memory DB was changed by an import (caller should persist).
 */
export async function syncTaskFiles(db: DB, log: string[]): Promise<boolean> {
  let dbChanged = false;
  const ids = db.tasks.map((t) => t.id);

  for (const t of db.tasks) {
    const dir = `${TASKS_DIR}/${t.id}`;
    const f = `${dir}/task.yaml`;
    // read mtime+content in one hop (or "none")
    let info: string;
    try {
      info = await nodeExec(
        `mkdir -p '${dir}'; if [ -f '${f}' ]; then printf '%s|' "$(stat -c %Y '${f}')"; base64 -w0 '${f}'; else printf none; fi`,
        20_000,
      );
    } catch { continue; }

    const st = syncState.get(t.id);

    if (info.startsWith("none")) {
      const y = serialize(t);
      await writeFile(f, y).catch(() => {});
      syncState.set(t.id, { yaml: y, at: Date.now() });
      continue;
    }

    const sep = info.indexOf("|");
    const mtimeMs = Number(info.slice(0, sep)) * 1000;
    const content = Buffer.from(info.slice(sep + 1), "base64").toString("utf8");

    // Human edit: file changed after our last write (2s grace for stat's 1s resolution).
    if (st && mtimeMs > st.at + 2000 && content.trim() !== st.yaml.trim()) {
      try {
        const parsed = yaml.load(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed === "object") {
          const applied = await mutate((d) => {
            const live = d.tasks.find((x) => x.id === t.id);
            return live ? applyObj(live, parsed) : false;
          });
          if (applied) { dbChanged = true; log.push(`task ${t.id}: applied edits from task.yaml`); }
        }
      } catch (e) {
        log.push(`! task ${t.id}: task.yaml parse error: ${String(e)}`);
      }
      // rewrite normalized so the file reflects the canonical form
      const fresh = db.tasks.find((x) => x.id === t.id) ?? t;
      const norm = serialize(fresh);
      await writeFile(f, norm).catch(() => {});
      syncState.set(t.id, { yaml: norm, at: Date.now() });
    } else {
      // Export if the canonical YAML drifted from what's on disk (GUI/API change).
      const desired = serialize(t);
      if (!st || desired.trim() !== st.yaml.trim()) {
        await writeFile(f, desired).catch(() => {});
        syncState.set(t.id, { yaml: desired, at: Date.now() });
      }
    }
  }

  // Prune stale task dirs (no matching task).
  try {
    const keep = ids.map((i) => `"${i}"`).join(" ");
    await nodeExec(
      `shopt -s nullglob; for d in ${TASKS_DIR}/*/; do n=$(basename "$d"); keep=0; for k in ${keep}; do [ "$n" = "$k" ] && keep=1; done; [ $keep -eq 0 ] && rm -rf "$d"; done`,
      20_000,
    );
  } catch { /* best effort */ }

  return dbChanged;
}
