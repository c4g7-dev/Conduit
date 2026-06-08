/**
 * Per-service shared config dir on the GlusterFS store, bind-mounted into the container at
 * /opt/shared and symlinked from the service's perf-safe config/plugin paths. This makes a
 * service's configs/plugins editable through the ONE central SFTP chroot + the file manager
 * (and replicated across nodes) — while the hot data (MC worlds, hytale data/, backups)
 * stays on the container's local disk for performance.
 *
 *   host:  /var/lib/conduit/services/<vmid>/   →  CT:/opt/shared   (pct mountpoint)
 *   then e.g. /opt/mc/plugins → /opt/shared/plugins (symlink), world* left local.
 */
import { nodeExec, ctExec } from "./provision";

const SERVICES_DIR = "/var/lib/conduit/services";

/** Perf-safe paths to relocate onto the shared store, by software kind (relative to serviceDir). */
function shareablePaths(kind: string): string[] {
  switch (kind) {
    case "paper":
      return ["plugins", "config", "server.properties", "bukkit.yml", "spigot.yml", "paper-global.yml", "permissions.yml", "ops.json", "whitelist.json"];
    case "velocity":
      return ["plugins", "velocity.toml", "forwarding.secret"];
    case "hytale":
      return ["jvm.options"];
    case "nginx":
      return ["."]; // whole docroot (low I/O)
    default:
      return [];
  }
}

function serviceDir(kind: string): string {
  if (kind === "hytale") return "/opt/hytale";
  if (kind === "nginx") return "/opt/www";
  return "/opt/mc";
}

/**
 * Ensure the /opt/shared bind-mount exists and the kind's config paths are relocated to it.
 * Adds the mountpoint (rebooting the CT once if newly added) and is idempotent thereafter.
 */
export async function ensureServiceShare(vmid: number, kind: string, host?: string): Promise<void> {
  const paths = shareablePaths(kind);
  if (paths.length === 0) return;
  const hostShare = `${SERVICES_DIR}/${vmid}`;
  const svcDir = serviceDir(kind);

  await nodeExec(`mkdir -p '${hostShare}'`, 15_000, host);

  // Add the bind mount if absent (find a free mp index; reboot to apply).
  const added = await nodeExec(
    `if pct config ${vmid} | grep -q ' mp=/opt/shared'; then echo present; else ` +
      `i=1; while pct config ${vmid} | grep -q "^mp$i:"; do i=$((i+1)); done; ` +
      `pct set ${vmid} -mp$i '${hostShare},mp=/opt/shared' && pct reboot ${vmid} && echo added; fi`,
    60_000, host,
  );
  if (added.includes("added")) {
    // wait for the CT to come back after reboot
    await nodeExec(`for n in $(seq 1 30); do pct exec ${vmid} -- true 2>/dev/null && break; sleep 2; done`, 90_000, host);
  }

  // Relocate each shareable path into /opt/shared and symlink it back (idempotent).
  const relocate = paths.map((p) => {
    if (p === ".") {
      // nginx: make /opt/www the shared dir itself (move contents once, then bind already covers it)
      return `if [ -d '${svcDir}' ] && [ ! -L '${svcDir}' ]; then cp -an '${svcDir}/.' /opt/shared/ 2>/dev/null || true; rm -rf '${svcDir}'; ln -s /opt/shared '${svcDir}'; fi`;
    }
    const src = `${svcDir}/${p}`;
    const dst = `/opt/shared/${p}`;
    return `if [ -e '${src}' ] && [ ! -L '${src}' ]; then mkdir -p "$(dirname '${dst}')"; mv '${src}' '${dst}' && ln -s '${dst}' '${src}'; elif [ ! -e '${src}' ]; then :; fi`;
  }).join("; ");

  await ctExec(vmid, `mkdir -p /opt/shared; ${relocate}; echo CONDUIT_SHARE_OK`, 60_000, host);
}
