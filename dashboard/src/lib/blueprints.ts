/**
 * Premade Conduit blueprints — the "templates" a task is built from.
 *
 * A blueprint is a role + base image + default resources. Creating a task from
 * a blueprint makes the controller provision LXCs from `base` (a Proxmox vztmpl),
 * tag them for the task, and keep the desired count alive.
 *
 * Actual MC software (Paper/Velocity) is installed in-container by the controller
 * after first boot (see lib/provision.ts): SSH → `pct exec` runs an idempotent
 * script that pulls the JRE + jar, writes config/systemd, and starts the service.
 * `provision` documents what each role installs.
 */

export type Role = "proxy" | "lobby" | "smp" | "db" | "generic";

/**
 * The software a blueprint installs + which version. `kind` is the install recipe
 * (paper/velocity implemented today; the seam is here to add nginx, hytale, … later);
 * `version` is what gets pulled — e.g. the Minecraft version for paper, the Velocity
 * version for velocity. Selectable per-task in the UI.
 */
export type SoftwareKind = "paper" | "velocity" | "mariadb" | "generic";
export type Software = { kind: SoftwareKind; version: string };

/** Declarative "game-ready" content applied in-container at first provision. */
export type Seed = {
  /** tar.gz of a Paper level dir (contains world/level.dat …), extracted into the server */
  worldUrl?: string;
  /** plugin jar download URLs → plugins/ */
  plugins?: string[];
  /** extra/override server.properties entries */
  properties?: Record<string, string>;
  /** 64×64 png URL → server-icon.png */
  icon?: string;
};

export type Blueprint = {
  id: string;
  name: string;
  role: Role;
  /** default scaling mode for tasks built from this blueprint */
  mode: "dynamic" | "static";
  persistent: boolean;
  base: string; // Proxmox vztmpl volid
  cores: number;
  memory: number; // MB
  disk: number; // GB
  port: number; // primary service port (for routing tables)
  description: string;
  provision: string;
  /** what software + which version this blueprint installs (version selectable per task) */
  software: Software;
  /**
   * Bind-mount the shared read-only `/assets` store into instances. For engines like
   * Hytale that share large static assets across servers. NOT for Minecraft — a Paper
   * server needs its own live, writable world/config, so MC blueprints leave this off.
   */
  sharedAssets?: boolean;
  /** default game-ready content for instances of this blueprint */
  seed?: Seed;
};

const DEBIAN = "local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst";

export const BLUEPRINTS: Blueprint[] = [
  {
    id: "velocity-proxy",
    name: "Velocity Proxy",
    role: "proxy",
    mode: "static",
    persistent: true,
    base: DEBIAN,
    cores: 2,
    memory: 2048,
    disk: 8,
    port: 25565,
    description:
      "Player-facing edge on :25565. Routes players to backend lobbies/SMP, holds slot limits & maintenance.",
    provision: "openjdk-17 + Velocity + modern-forwarding secret, servers pushed live",
    software: { kind: "velocity", version: "3.3.0-SNAPSHOT" },
  },
  {
    id: "paper-lobby",
    name: "Paper Lobby",
    role: "lobby",
    mode: "dynamic",
    persistent: false,
    base: DEBIAN,
    cores: 2,
    memory: 4096,
    disk: 8,
    port: 25565,
    description:
      "Stateless spawn/lobby. Autoscales on player count, cloned from template, thrown away when idle.",
    provision: "Paper (offline-mode, Velocity modern forwarding)",
    software: { kind: "paper", version: "1.20.4" },
    seed: {
      // a superflat lobby world, hosted in the conduit-assets repo
      worldUrl:
        "https://raw.githubusercontent.com/c4g7-dev/conduit-assets/master/worlds/lobby-flat.tar.gz",
      properties: {
        gamemode: "adventure",
        "force-gamemode": "true",
        difficulty: "peaceful",
        "spawn-monsters": "false",
        "spawn-protection": "0",
        pvp: "false",
        "allow-nether": "false",
        "level-type": "flat",
      },
    },
  },
  {
    id: "paper-smp",
    name: "Paper SMP / Region",
    role: "smp",
    mode: "static",
    persistent: true,
    base: DEBIAN,
    cores: 4,
    memory: 8192,
    disk: 24,
    port: 25565,
    description:
      "Persistent survival/region server. Fixed count, world on its own dataset, nightly PBS backup.",
    provision: "Paper (persistent world, Velocity modern forwarding)",
    software: { kind: "paper", version: "1.20.4" },
  },
  {
    id: "mariadb",
    name: "MariaDB",
    role: "db",
    mode: "static",
    persistent: true,
    base: DEBIAN,
    cores: 2,
    memory: 2048,
    disk: 16,
    port: 3306,
    description: "Shared database for the network. Persistent, backed up.",
    provision: "mariadb-server + conduit schema",
    software: { kind: "mariadb", version: "latest" },
  },
];

export function blueprint(id: string): Blueprint | undefined {
  return BLUEPRINTS.find((b) => b.id === id);
}
