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

/** Path to the JRE installed by javaInstall() — referenced by the systemd unit. */
const JAVA_BIN = "/opt/jre/bin/java";

/**
 * Shell to install a JRE of any major via the Adoptium binary API (works for 8…25+,
 * unlike the apt repo which lags new releases). Extracted to /opt/jre.
 */
function javaInstall(major: number): string {
  return `apt-get install -y -qq curl ca-certificates >/dev/null
mkdir -p /opt/jre
curl -fsSL "https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/x64/jre/hotspot/normal/eclipse" -o /tmp/jre.tgz
tar xzf /tmp/jre.tgz -C /opt/jre --strip-components=1
rm -f /tmp/jre.tgz
${JAVA_BIN} -version 2>&1 | head -1`;
}

/**
 * Resolve a Paper/Velocity version to its newest build's jar URL + required Java major,
 * via the PaperMC v3 "Fill" API (the v2 API is frozen and misses newer MC versions).
 */
type Resolved = { javaMajor: number; jarUrl: string };
async function resolveBuild(project: "paper" | "velocity", version: string): Promise<Resolved> {
  const base = `https://fill.papermc.io/v3/projects/${project}`;
  const meta = await fetch(`${base}/versions/${version}`).then((r) => r.json());
  const javaMajor: number = meta?.version?.java?.version?.minimum ?? 21;
  const builds = await fetch(`${base}/versions/${version}/builds`).then((r) => r.json());
  const first = Array.isArray(builds) ? builds[0] : builds?.builds?.[0];
  const jarUrl: string | undefined = first?.downloads?.["server:default"]?.url;
  if (!jarUrl) throw new Error(`no ${project} build for ${version}`);
  return { javaMajor, jarUrl };
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

function paperScript(task: Task, secret: string, seed: Seed, build: Resolved): string {
  const mem = heap(task.memory, 1024, 1024);
  // properties parser reads \n as a newline; keep it literal in the file
  const motd = colorize(task.motd || defaultMotd(task.name)).replace(/\n/g, "\\n");
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
    `${JAVA_BIN} -Xms${mem}M -Xmx${mem}M -XX:+UseG1GC -jar server.jar --nogui`,
  );
  return `set -e
MCDIR=/opt/mc
mkdir -p "$MCDIR/config"
if [ -f "$MCDIR/.conduit-ready" ]; then echo "already-provisioned"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
${javaInstall(build.javaMajor)}
echo "paper jar (java ${build.javaMajor})"
curl -fsSL -o "$MCDIR/server.jar" '${build.jarUrl}'
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
  const build = await resolveBuild("paper", version);
  await ctExec(vmid, paperScript(task, secret, seed, build));
}

/* ---- Velocity (proxy) ---------------------------------------------------- */

function velocityScript(task: Task, secret: string, build: Resolved): string {
  const mem = heap(task.memory, 512, 512);
  const unit = sysdUnit(
    `Conduit Velocity (${task.name})`,
    `${JAVA_BIN} -Xms256M -Xmx${mem}M -jar velocity.jar`,
  );
  return `set -e
MCDIR=/opt/mc
mkdir -p "$MCDIR"
if [ -f "$MCDIR/.conduit-ready" ]; then echo "already-provisioned"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
${javaInstall(build.javaMajor)}
echo "velocity jar (java ${build.javaMajor})"
curl -fsSL -o "$MCDIR/velocity.jar" '${build.jarUrl}'
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
  const build = await resolveBuild("velocity", version);
  await ctExec(vmid, velocityScript(task, secret, build));
}

/** Default MOTD for a task when none is set. */
export const defaultMotd = (name: string) => `Conduit §b${name}`;

/** Translate '&' colour codes to the section sign Paper/legacy servers expect. */
const colorize = (s: string) => s.replace(/&([0-9a-fk-or])/gi, "§$1");

// '&' code → MiniMessage tag (Velocity 3.x parses its MOTD as MiniMessage, not legacy).
const MINI: Record<string, string> = {
  "0": "black", "1": "dark_blue", "2": "dark_green", "3": "dark_aqua",
  "4": "dark_red", "5": "dark_purple", "6": "gold", "7": "gray",
  "8": "dark_gray", "9": "blue", a: "green", b: "aqua", c: "red",
  d: "light_purple", e: "yellow", f: "white",
  l: "bold", o: "italic", n: "underlined", m: "strikethrough", k: "obfuscated", r: "reset",
};
/** Convert a legacy '&'-coded string to MiniMessage for Velocity. */
function miniMessage(s: string): string {
  return s
    .replace(/&([0-9a-fk-or])/gi, (_, c) => `<${MINI[c.toLowerCase()]}>`)
    .replace(/\n/g, "<newline>");
}

/**
 * Update a running server's MOTD without a full reinstall, then restart it.
 * Paper → server.properties `motd=`; Velocity → velocity.toml `motd =`.
 */
export async function setMotd(vmid: number, role: string, motd: string): Promise<void> {
  // Files want a LITERAL \n for line breaks; but GNU sed turns \n in its replacement
  // into a real newline, so we feed sed \\n (which it emits as the literal \n we want).
  const m = colorize(motd).replace(/\n/g, "\\\\n");
  if (role === "proxy") {
    const v = m.replace(/"/g, '\\"');
    await ctExec(
      vmid,
      `sed -i 's#^motd = .*#motd = "${v}"#' /opt/mc/velocity.toml && systemctl restart mc`,
      60_000,
    );
  } else {
    const p = m.replace(/#/g, "\\#");
    await ctExec(
      vmid,
      `sed -i 's#^motd=.*#motd=${p}#' /opt/mc/server.properties && systemctl restart mc`,
      60_000,
    );
  }
}

export type ProxyServer = { name: string; ip: string; port: number };

function velocityToml(task: Task, servers: ProxyServer[]): string {
  const list = servers.map((s) => `${s.name} = "${s.ip}:${s.port}"`).join("\n");
  const tryList = servers.map((s) => `"${s.name}"`).join(", ");
  // Velocity parses its MOTD as MiniMessage; <newline> handles line breaks.
  const motd = miniMessage(task.motd || defaultMotd(task.name)).replace(/"/g, '\\"');
  return `# Managed by Conduit — regenerated on backend changes.
config-version = "2.7"
bind = "0.0.0.0:25565"
motd = "${motd}"
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
