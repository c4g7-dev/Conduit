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
    provision: "openjdk-17 + Velocity 3.3.0 + modern-forwarding secret, servers pushed live",
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
    provision: "openjdk-17 + Paper 1.20.4 (offline-mode, Velocity modern forwarding)",
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
    provision: "openjdk-17 + Paper 1.20.4 (persistent world, Velocity modern forwarding)",
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
  },
];

export function blueprint(id: string): Blueprint | undefined {
  return BLUEPRINTS.find((b) => b.id === id);
}
