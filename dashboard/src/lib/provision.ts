/**
 * In-container software provisioning for Conduit.
 *
 * Proxmox has no API to exec inside an LXC, so we SSH to the node (root) and run
 * `pct exec <vmid> -- …`. Scripts are base64-piped so quoting/secrets stay intact.
 * Everything here is idempotent: a `/opt/mc/.conduit-ready` marker short-circuits
 * re-installs, and config pushes only restart a service when content changed.
 *
 * Versions are pinned to what the Debian-12 base JRE (openjdk-17) supports:
 *   Paper 1.20.4 · Velocity 3.3.0-SNAPSHOT  (1.20.5+/Velocity 3.4+ need Java 21)
 */
import { spawn } from "node:child_process";
import type { Task } from "./store";
import type { Seed } from "./blueprints";

const SSH_HOST = process.env.PROXMOX_SSH_HOST ?? process.env.PROXMOX_HOST ?? "10.27.27.126";
const SSH_USER = process.env.PROXMOX_SSH_USER ?? "root";
const SSH_PASS = process.env.PROXMOX_SSH_PASS ?? process.env.PROXMOX_PASS ?? "";
// Prefer key auth (no password on the wire). Falls back to sshpass+password.
const SSH_KEY = process.env.PROXMOX_SSH_KEY ?? "";

/** Minecraft version → required Java major. ≤1.20.4 → 17, ≥1.20.5 / 1.21+ → 21. */
function javaForMc(v: string): 17 | 21 {
  const [a, b, c] = v.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  if (a > 1 || (a === 1 && b >= 21)) return 21;
  if (a === 1 && b === 20 && c >= 5) return 21;
  return 17;
}

/** Shell to install the right JRE. 17 from Debian; 21 from Adoptium (Temurin). */
function javaInstall(major: 17 | 21): string {
  if (major === 21)
    return `apt-get install -y -qq curl ca-certificates gpg >/dev/null
mkdir -p /etc/apt/keyrings
curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg
echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list
apt-get update -qq
apt-get install -y -qq temurin-21-jre >/dev/null`;
  return `apt-get install -y -qq openjdk-17-jre-headless curl ca-certificates >/dev/null`;
}

/** Run a command on the Proxmox node over SSH (key auth if configured, else password). */
function ssh(remote: string, timeoutMs = 360_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sshOpts = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=ERROR",
    ];
    let cmd: string;
    let args: string[];
    if (SSH_KEY) {
      cmd = "ssh";
      args = ["-i", SSH_KEY, "-o", "BatchMode=yes", ...sshOpts, `${SSH_USER}@${SSH_HOST}`, remote];
    } else {
      cmd = "sshpass";
      args = ["-p", SSH_PASS, "ssh", ...sshOpts, `${SSH_USER}@${SSH_HOST}`, remote];
    }
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ssh exit ${code}: ${(err || out).trim().slice(-500)}`));
    });
  });
}

/** Run a command directly on the Proxmox node (as root, e.g. `pct set …`). */
export async function nodeExec(cmd: string, timeoutMs = 60_000): Promise<string> {
  return ssh(cmd, timeoutMs);
}

/** Run a bash script inside an LXC (base64-piped to dodge quoting). */
export async function ctExec(vmid: number, script: string, timeoutMs = 360_000): Promise<string> {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return ssh(`pct exec ${vmid} -- bash -c 'echo ${b64} | base64 -d | bash'`, timeoutMs);
}

/** Write a file inside an LXC. */
export async function ctWrite(vmid: number, path: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  await ctExec(vmid, `mkdir -p "$(dirname '${path}')"; echo ${b64} | base64 -d > '${path}'`, 60_000);
}

const heap = (mem: number, reserve: number, floor: number) =>
  Math.max(floor, mem - reserve);

const sysdUnit = (desc: string, exec: string) => `[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/mc
ExecStart=${exec}
Restart=always
RestartSec=5
SuccessExitStatus=0 143

[Install]
WantedBy=multi-user.target
`;

/* ---- Paper (lobby / SMP) ------------------------------------------------- */

/**
 * Shell that fetches seed content (world / plugins / icon) into the server dir.
 * Sources may be URLs (curled) or absolute paths — typically under the shared
 * read-only `/assets` mount — which are copied from the mount instead of downloaded.
 */
function seedShell(seed: Seed): string {
  // local /assets path → copy from the shared mount; otherwise curl the URL
  const fetchTo = (src: string, dest: string) =>
    src.startsWith("/")
      ? `cp '${src}' '${dest}'`
      : `curl -fsSL -o '${dest}' '${src}'`;
  const lines: string[] = ['mkdir -p "$MCDIR/plugins"'];
  if (seed.worldUrl) {
    const extract = seed.worldUrl.startsWith("/")
      ? `tar xzf '${seed.worldUrl}' -C "$MCDIR"`
      : `curl -fsSL -o /tmp/seed-world.tgz '${seed.worldUrl}' && tar xzf /tmp/seed-world.tgz -C "$MCDIR" && rm -f /tmp/seed-world.tgz`;
    lines.push(
      // only seed if there's no world yet (don't clobber a persistent one)
      `if [ ! -f "$MCDIR/world/level.dat" ]; then`,
      `  echo "seeding world"; ${extract} || echo "world seed failed"`,
      `fi`,
    );
  }
  for (const src of seed.plugins ?? []) {
    const dest = `$MCDIR/plugins/$(basename '${src}' | cut -d'?' -f1)`;
    lines.push(`${fetchTo(src, dest)} || echo "plugin seed failed: ${src}"`);
  }
  if (seed.icon) lines.push(`${fetchTo(seed.icon, "$MCDIR/server-icon.png")} || true`);
  return lines.join("\n");
}

function paperScript(task: Task, secret: string, seed: Seed, version: string): string {
  const mem = heap(task.memory, 1024, 1024);
  const motd = `Conduit \\u00b7 ${task.name}`;
  const maxPlayers = Math.max(20, task.playersPerInstance);
  const baseProps: Record<string, string> = {
    "server-port": "25565",
    "online-mode": "false",
    motd,
    "max-players": String(maxPlayers),
    "spawn-protection": "0",
    "allow-nether": "true",
    "enable-command-block": "true",
  };
  const props = Object.entries({ ...baseProps, ...(seed.properties ?? {}) })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  // Paper reads config/paper-global.yml; a minimal file is merged with defaults.
  const paperGlobal = `_version: 28
proxies:
  velocity:
    enabled: true
    online-mode: false
    secret: ${secret}
`;
  const unit = sysdUnit(
    `Conduit Paper (${task.name})`,
    `/usr/bin/java -Xms${mem}M -Xmx${mem}M -XX:+UseG1GC -jar server.jar --nogui`,
  );
  return `set -e
MCDIR=/opt/mc
mkdir -p "$MCDIR/config"
if [ -f "$MCDIR/.conduit-ready" ]; then echo "already-provisioned"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
${javaInstall(javaForMc(version))}
VER=${version}
BUILD=$(curl -fsSL "https://api.papermc.io/v2/projects/paper/versions/$VER/builds" | tr ',' '\\n' | grep -o '"build":[0-9]*' | grep -o '[0-9]*' | tail -1)
if [ -z "$BUILD" ]; then echo "no paper build for $VER" >&2; exit 1; fi
echo "paper $VER build $BUILD (java ${javaForMc(version)})"
curl -fsSL -o "$MCDIR/server.jar" "https://api.papermc.io/v2/projects/paper/versions/$VER/builds/$BUILD/downloads/paper-$VER-$BUILD.jar"
echo "eula=true" > "$MCDIR/eula.txt"
cat > "$MCDIR/server.properties" <<'PROP'
${props}
PROP
cat > "$MCDIR/config/paper-global.yml" <<'YML'
${paperGlobal}
YML
cat > /etc/systemd/system/mc.service <<'UNIT'
${unit}
UNIT
${seedShell(seed)}
systemctl daemon-reload
systemctl enable mc >/dev/null 2>&1 || true
systemctl restart mc
touch "$MCDIR/.conduit-ready"
echo CONDUIT_PROVISIONED_PAPER
`;
}

export async function installPaper(
  vmid: number,
  task: Task,
  secret: string,
  seed: Seed = {},
  version = "1.20.4",
): Promise<void> {
  await ctExec(vmid, paperScript(task, secret, seed, version));
}

/* ---- Velocity (proxy) ---------------------------------------------------- */

function velocityScript(task: Task, secret: string, version: string): string {
  const mem = heap(task.memory, 512, 512);
  const unit = sysdUnit(
    `Conduit Velocity (${task.name})`,
    `/usr/bin/java -Xms256M -Xmx${mem}M -jar velocity.jar`,
  );
  return `set -e
MCDIR=/opt/mc
mkdir -p "$MCDIR"
if [ -f "$MCDIR/.conduit-ready" ]; then echo "already-provisioned"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
${javaInstall(17)}
VER=${version}
BUILD=$(curl -fsSL "https://api.papermc.io/v2/projects/velocity/versions/$VER/builds" | tr ',' '\\n' | grep -o '"build":[0-9]*' | grep -o '[0-9]*' | tail -1)
if [ -z "$BUILD" ]; then echo "no velocity build for $VER" >&2; exit 1; fi
echo "velocity $VER build $BUILD"
curl -fsSL -o "$MCDIR/velocity.jar" "https://api.papermc.io/v2/projects/velocity/versions/$VER/builds/$BUILD/downloads/velocity-$VER-$BUILD.jar"
printf '%s' '${secret}' > "$MCDIR/forwarding.secret"
cat > /etc/systemd/system/mc.service <<'UNIT'
${unit}
UNIT
systemctl daemon-reload
systemctl enable mc >/dev/null 2>&1 || true
touch "$MCDIR/.conduit-ready"
echo CONDUIT_PROVISIONED_VELOCITY
`;
}

export async function installVelocity(
  vmid: number,
  task: Task,
  secret: string,
  version = "3.3.0-SNAPSHOT",
): Promise<void> {
  await ctExec(vmid, velocityScript(task, secret, version));
}

export type ProxyServer = { name: string; ip: string; port: number };

function velocityToml(task: Task, servers: ProxyServer[]): string {
  const list = servers.map((s) => `${s.name} = "${s.ip}:${s.port}"`).join("\n");
  const tryList = servers.map((s) => `"${s.name}"`).join(", ");
  return `# Managed by Conduit — regenerated on backend changes.
config-version = "2.7"
bind = "0.0.0.0:25565"
motd = "Conduit · ${task.name}"
show-max-players = 1000
online-mode = false
player-info-forwarding-mode = "modern"
forwarding-secret-file = "forwarding.secret"
announce-forge = false

[servers]
${list}
try = [${tryList}]

[forced-hosts]

[advanced]
compression-threshold = 256

[query]
enabled = false
`;
}

// proxy vmid -> last pushed server signature, so we only restart on real changes.
const lastSig = new Map<number, string>();

/** Push the live backend list into a proxy's velocity.toml; restart only if changed. */
export async function syncVelocity(
  vmid: number,
  task: Task,
  servers: ProxyServer[],
): Promise<boolean> {
  const sig = servers
    .map((s) => `${s.name}=${s.ip}:${s.port}`)
    .sort()
    .join(",");
  if (lastSig.get(vmid) === sig) return false;
  await ctWrite(vmid, "/opt/mc/velocity.toml", velocityToml(task, servers));
  await ctExec(vmid, "systemctl restart mc", 60_000);
  lastSig.set(vmid, sig);
  return true;
}

export function forgetVelocity(vmid: number): void {
  lastSig.delete(vmid);
}
