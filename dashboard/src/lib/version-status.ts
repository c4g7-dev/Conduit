/**
 * Version tracking for the network's software (ideas.md §1):
 *   - hotfix  = a newer BUILD of the task's pinned version line (e.g. Paper 1.21.4 #82 → #83).
 *               Auto-applied when task.autoUpdate is on; one click otherwise.
 *   - upgrade = a newer FULL version upstream (1.21.4 → 1.21.5). NEVER automatic — surfaced
 *               as "update available" and applied only explicitly.
 * Paper/Velocity resolve against the PaperMC Fill API; Hytale has no public version feed, so
 * it reports its configured version as static. Lookups are cached (builds 10 min, versions 1h).
 */
import { getDB, type Task } from "./store";
import { blueprint, loadBlueprints } from "./blueprints";
import { latestBuildFor } from "./provision";

export type TaskVersionStatus = {
  taskId: string;
  name: string;
  kind: string;
  version: string;          // pinned line
  installedBuild?: number;
  latestBuild?: number;     // newest build of the pinned line
  hotfixAvailable: boolean;
  latestVersion?: string;   // newest full version upstream
  updateAvailable: boolean; // latestVersion !== version
  autoUpdate: boolean;
  static?: boolean;         // no upstream feed (hytale/generic) — version display only
};

declare global {
  // eslint-disable-next-line no-var
  var __conduitVerCache: Map<string, { at: number; v: unknown }> | undefined;
}
const cache = (global.__conduitVerCache ??= new Map());

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** Newest stable full version of a PaperMC project (first entry of the versions feed). */
async function latestVersionOf(project: "paper" | "velocity"): Promise<string | undefined> {
  return cached(`ver:${project}`, 3_600_000, async () => {
    const res = await fetch(`https://fill.papermc.io/v3/projects/${project}/versions`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    const v = (json.versions ?? [])
      .map((x: { version?: { id?: string } }) => x.version?.id)
      .filter(Boolean)[0] as string | undefined;
    return v;
  });
}

async function latestBuildCached(project: "paper" | "velocity", version: string): Promise<{ build: number; jarUrl: string } | null> {
  return cached(`build:${project}:${version}`, 600_000, async () => {
    try {
      const b = await latestBuildFor(project, version);
      return { build: b.build, jarUrl: b.jarUrl };
    } catch {
      return null;
    }
  });
}

export function effectiveVersion(t: Task): { kind: string; version: string } {
  const bp = blueprint(t.blueprintId);
  return {
    kind: bp?.software.kind ?? "generic",
    version: t.software?.version ?? bp?.software.version ?? "",
  };
}

/** Version status for every task that runs versioned software. */
export async function versionStatuses(): Promise<TaskVersionStatus[]> {
  await loadBlueprints();
  const db = await getDB();
  const out: TaskVersionStatus[] = [];
  for (const t of db.tasks) {
    const { kind, version } = effectiveVersion(t);
    if (kind === "paper" || kind === "velocity") {
      const [latest, latestVer] = await Promise.all([
        latestBuildCached(kind, version),
        latestVersionOf(kind).catch(() => undefined),
      ]);
      out.push({
        taskId: t.id,
        name: t.name,
        kind,
        version,
        installedBuild: t.installedBuild,
        latestBuild: latest?.build,
        hotfixAvailable: !!(latest && t.installedBuild && latest.build > t.installedBuild),
        latestVersion: latestVer,
        updateAvailable: !!(latestVer && latestVer !== version),
        autoUpdate: !!t.autoUpdate,
      });
    } else if (kind === "hytale") {
      out.push({
        taskId: t.id, name: t.name, kind, version,
        hotfixAvailable: false, updateAvailable: false,
        autoUpdate: false, static: true,
      });
    }
  }
  return out;
}

/** The latest jar of a version line (for hotfix/upgrade application). */
export async function jarFor(kind: "paper" | "velocity", version: string): Promise<{ build: number; jarUrl: string }> {
  const b = await latestBuildCached(kind, version);
  if (!b) throw new Error(`no ${kind} build found for ${version}`);
  return b;
}
