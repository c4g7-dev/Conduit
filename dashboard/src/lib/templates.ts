/**
 * CloudNet-style file "overlays" on the shared (GlusterFS) store at /var/lib/conduit.
 * (Named "overlays" to avoid clashing with egg install-definitions, which the UI calls
 * "Templates".)
 *
 *   overlays/<eggId>/   base file tree for an egg (plugins, configs, www…)
 *   tasks/<taskId>/     per-task overlay applied on top of the egg overlay
 *
 * At provision the engine copies overlays/<eggId>/ then tasks/<taskId>/ into the service's
 * working dir inside the container. Because the store is the gluster mount on the host, we
 * tar on the host and `pct push` into the container (same hop as asset seeding). Editing
 * these trees in the file manager / SFTP therefore changes what new (and re-seeded)
 * services get — exactly the CloudNet model.
 */
import { nodeExec } from "./provision";

export const CONDUIT_ROOT = "/var/lib/conduit";
export const OVERLAYS_DIR = `${CONDUIT_ROOT}/overlays`;
export const TASKS_DIR = `${CONDUIT_ROOT}/tasks`;
/** named generic templates (overlays/_tpl/<id>/), applied to hand-picked services */
export const TPL_DIR = `${OVERLAYS_DIR}/_tpl`;

/** The in-container working dir a service's files live in, by software kind. */
export function serviceDir(kind: string): string {
  if (kind === "hytale") return "/opt/hytale";
  if (kind === "nginx") return "/opt/www";
  return "/opt/mc";
}

/**
 * Ordered overlay source dirs for a task, lowest priority first (later layers overwrite):
 *   egg overlay → kind-wide _global → named global templates → per-task overrides.
 * `tplIds` are the named templates that list this task (resolved by the caller from the store).
 */
export function overlayDirs(eggId: string, taskId: string, kind: string, tplIds: string[] = []): string[] {
  return [
    `${OVERLAYS_DIR}/${eggId}`,
    `${OVERLAYS_DIR}/_global/${kind}`,
    ...tplIds.map((id) => `${TPL_DIR}/${id}`),
    `${TASKS_DIR}/${taskId}`,
  ];
}

/** Create the dir for a named global template on the shared store (file-manager editable). */
export async function ensureGlobalTemplateDir(id: string, host?: string): Promise<void> {
  await nodeExec(`mkdir -p '${TPL_DIR}/${id}'`, 20_000, host);
}

/** Remove a named global template's files (called when the template is deleted). */
export async function removeGlobalTemplateDir(id: string, host?: string): Promise<void> {
  // guard against an empty id wiping the parent
  if (!/^[a-z0-9-]+$/.test(id)) return;
  await nodeExec(`rm -rf '${TPL_DIR}/${id}'`, 20_000, host);
}

/** Ensure an egg's template dir exists (optionally seeding default files on first create). */
export async function ensureTemplate(eggId: string, seed?: Record<string, string>, host?: string): Promise<void> {
  const dir = `${OVERLAYS_DIR}/${eggId}`;
  let script = `mkdir -p '${dir}'`;
  for (const [rel, content] of Object.entries(seed ?? {})) {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const path = `${dir}/${rel}`;
    // only write the seed file if the template is empty for that path (don't clobber edits)
    script += `; mkdir -p "$(dirname '${path}')"; [ -e '${path}' ] || (echo ${b64} | base64 -d > '${path}')`;
  }
  await nodeExec(script, 30_000, host);
}

/**
 * Copy the overlay chain (see {@link overlayDirs}) into <destDir> inside the container, lowest
 * priority first so later layers overwrite earlier ones (ideas.md §2 prioritization).
 * No-op for empty/missing layers. Runs entirely on the host (tar + pct push + extract).
 */
export async function applyTemplate(
  vmid: number, eggId: string, taskId: string, destDir: string, host?: string, kind = "", tplIds: string[] = [],
): Promise<void> {
  const one = async (srcDir: string) => {
    const tgz = `/tmp/ct-tmpl-${vmid}.tgz`;
    await nodeExec(
      `if [ -d '${srcDir}' ] && [ -n "$(ls -A '${srcDir}' 2>/dev/null)" ]; then ` +
        `tar czf ${tgz} -C '${srcDir}' . && ` +
        `pct exec ${vmid} -- mkdir -p '${destDir}' && ` +
        `pct push ${vmid} ${tgz} /tmp/ct-tmpl.tgz && ` +
        `pct exec ${vmid} -- tar xzf /tmp/ct-tmpl.tgz -C '${destDir}' && ` +
        `pct exec ${vmid} -- rm -f /tmp/ct-tmpl.tgz && rm -f ${tgz}; ` +
      `fi`,
      120_000, host,
    );
  };
  for (const dir of overlayDirs(eggId, taskId, kind, tplIds)) await one(dir);
}

/**
 * Change signature of a task's full overlay chain (file paths + sizes + mtimes). The reconcile
 * loop diffs this for templateSync tasks: when an overlay edit lands (file manager / SFTP),
 * affected services get the files re-applied (and optionally restarted) automatically —
 * ideas.md §2 "rewrite on change" for static services, without manual re-seeding.
 */
export async function overlaySignature(eggId: string, taskId: string, kind: string, host?: string, tplIds: string[] = []): Promise<string> {
  const dirs = overlayDirs(eggId, taskId, kind, tplIds);
  const out = await nodeExec(
    dirs.map((d) => `([ -d '${d}' ] && find '${d}' -type f -printf '%P %s %T@\\n' | sort) || true`).join("; "),
    30_000, host,
  );
  return out.trim();
}
