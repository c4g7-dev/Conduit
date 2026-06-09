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
import { readFile } from "node:fs/promises";
import type { Task } from "./store";
import type { Seed, Software } from "./blueprints";

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

/**
 * Run a command on a Proxmox node over SSH (key auth if configured, else password).
 * `host` targets a specific node (its IP) for multi-node clusters; defaults to the
 * configured node. The dashboard host must be able to reach every node's IP.
 */
// Per-VMID install log buffer — streamed to the UI during provisioning.
const installLogs = new Map<number, string[]>();
const MAX_LOG_LINES = 600;

function appendInstallLog(vmid: number, text: string) {
  if (!installLogs.has(vmid)) installLogs.set(vmid, []);
  const buf = installLogs.get(vmid)!;
  buf.push(...text.split("\n").filter((l) => l.length > 0));
  if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
}

export function getInstallLog(vmid: number): string[] {
  return [...(installLogs.get(vmid) ?? [])];
}

export function clearInstallLog(vmid: number) {
  installLogs.delete(vmid);
}

export function pushInstallLog(vmid: number, line: string) {
  appendInstallLog(vmid, line);
}

function ssh(remote: string, timeoutMs = 360_000, host = SSH_HOST, logVmid?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // ControlMaster reuses an existing SSH connection so subsequent calls skip
    // the key-exchange handshake (~5 ms instead of ~80 ms — critical for console polling).
    const sshOpts = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=ERROR",
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=/tmp/conduit_ssh_${host.replace(/[^a-z0-9]/gi, "_")}`,
      "-o", "ControlPersist=60",
    ];
    let cmd: string;
    let args: string[];
    if (SSH_KEY) {
      cmd = "ssh";
      args = ["-i", SSH_KEY, "-o", "BatchMode=yes", ...sshOpts, `${SSH_USER}@${host}`, remote];
    } else {
      cmd = "sshpass";
      args = ["-p", SSH_PASS, "ssh", ...sshOpts, `${SSH_USER}@${host}`, remote];
    }
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => {
      const text = String(d);
      out += text;
      if (logVmid !== undefined) appendInstallLog(logVmid, text);
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ssh exit ${code}: ${(err || out).trim().slice(-500)}`));
    });
  });
}

/** Run a command directly on a Proxmox node (as root, e.g. `pct set …`). */
export async function nodeExec(cmd: string, timeoutMs = 60_000, host?: string): Promise<string> {
  return ssh(cmd, timeoutMs, host ?? SSH_HOST);
}

/** Run a bash script inside an LXC (base64-piped to dodge quoting), on the CT's node.
 *  stdout is also streamed into the per-vmid install log for the UI console. */
export async function ctExec(vmid: number, script: string, timeoutMs = 360_000, host?: string): Promise<string> {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return ssh(`pct exec ${vmid} -- bash -c 'echo ${b64} | base64 -d | bash'`, timeoutMs, host ?? SSH_HOST, vmid);
}

/** Write a file inside an LXC. */
export async function ctWrite(vmid: number, path: string, content: string, host?: string): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  await ctExec(vmid, `mkdir -p "$(dirname '${path}')"; echo ${b64} | base64 -d > '${path}'`, 60_000, host);
}

const heap = (mem: number, reserve: number, floor: number) =>
  Math.max(floor, mem - reserve);

/**
 * systemd unit that runs the server inside a detached tmux session named `mc`
 * (on its own socket, `-L mc`), so Conduit can drive the in-game console:
 *   - send input:  tmux -L mc send-keys -t mc '<cmd>' Enter
 *   - read output: tmux -L mc capture-pane -p -t mc -S -200
 *
 * `Type=forking`: `tmux new-session -d` daemonises and exits, so systemd tracks
 * the forked tmux server. ExecStop sends the server's own `stop` command into the
 * session for a graceful shutdown (Paper & Velocity both accept `stop`); a fixed
 * `-x 220 -y 50` pane keeps capture-pane output width stable. Restart=always
 * still recovers from crashes.
 *
 * NOTE: the exact tmux/systemd incantation is to be live-verified during
 * integration — this is the clean, plausible baseline.
 */
/** Path the systemd unit sources connector identity from (rewritten per-clone). */
export const CONNECTOR_ENV_FILE = "/etc/conduit/connector.env";

/** Env vars the Conduit connector plugin reads (endpoint/token/identity). */
function connectorEnv(vmid: number, task: Task): Record<string, string> {
  const vip = process.env.CONDUIT_VIP || process.env.PROXMOX_HOST || "10.27.27.50";
  const token = process.env.CONDUIT_CONNECTOR_TOKEN || process.env.CONDUIT_AGENT_TOKEN || "";
  return {
    CONDUIT_ENDPOINT: `http://${vip}:3001`,
    CONDUIT_TOKEN: token,
    CONDUIT_SERVICE_ID: `${task.id}-${vmid}`,
    CONDUIT_TASK: task.name,
    CONDUIT_GROUP: task.groupId,
  };
}

/** Shell that writes the connector EnvironmentFile inside a container (used at install + clone). */
export function connectorEnvScript(vmid: number, task: Task): string {
  const env = connectorEnv(vmid, task);
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  const b64 = Buffer.from(body, "utf8").toString("base64");
  return `mkdir -p /etc/conduit && echo ${b64} | base64 -d > ${CONNECTOR_ENV_FILE}`;
}

/** Rewrite a clone's connector identity file + restart so it registers as itself. */
export async function reidentifyConnector(vmid: number, task: Task, host?: string): Promise<void> {
  const b64 = Buffer.from(connectorEnvScript(vmid, task), "utf8").toString("base64");
  await nodeExec(
    `pct exec ${vmid} -- bash -c 'echo ${b64} | base64 -d | bash' && pct exec ${vmid} -- systemctl restart mc 2>/dev/null || true`,
    60_000, host,
  );
}

/** Push the connector jar (from the shared store) into a container's plugins dir. */
export async function installConnector(vmid: number, host?: string): Promise<void> {
  const jar = "/var/lib/conduit/connector/conduit-connector.jar";
  await nodeExec(
    `if [ -f '${jar}' ]; then pct exec ${vmid} -- mkdir -p /opt/mc/plugins && pct push ${vmid} '${jar}' /opt/mc/plugins/conduit-connector.jar; fi`,
    60_000, host,
  );
}

/**
 * Push the Hytale connector jar into the Hytale server's external-plugins dir.
 * Hytale loads external plugins from `mods/` relative to the server CWD, which is
 * `${HYTALE_DIR}/data` (start.sh does `cd .../data`) → `${HYTALE_DIR}/data/mods`.
 */
export async function installHytaleConnector(vmid: number, host?: string): Promise<void> {
  const jar = "/var/lib/conduit/connector/conduit-hytale.jar";
  await nodeExec(
    `if [ -f '${jar}' ]; then pct exec ${vmid} -- mkdir -p ${HYTALE_DIR}/data/mods && pct push ${vmid} '${jar}' ${HYTALE_DIR}/data/mods/conduit-hytale.jar; fi`,
    60_000, host,
  );
}

const sysdUnit = (desc: string, exec: string, workDir = "/opt/mc", useConnectorEnv = false) => `[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
WorkingDirectory=${workDir}
${useConnectorEnv ? `EnvironmentFile=-${CONNECTOR_ENV_FILE}` : ""}
ExecStart=/usr/bin/tmux -L mc new-session -d -s mc -x 220 -y 50 '${exec}'
ExecStop=/usr/bin/tmux -L mc send-keys -t mc 'stop' Enter
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

function paperScript(task: Task, secret: string, seed: Seed, build: Resolved, vmid: number): string {
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
    "/opt/mc",
    true,
  );
  return `set -e
MCDIR=/opt/mc
mkdir -p "$MCDIR/config"
if [ -f "$MCDIR/.conduit-ready" ]; then echo "already-provisioned"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tmux >/dev/null
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
${connectorEnvScript(vmid, task)}
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
  host?: string,
): Promise<void> {
  const build = await resolveBuild("paper", version);
  await ctExec(vmid, paperScript(task, secret, seed, build, vmid), 360_000, host);
}

/* ---- Hytale (shared-asset mount) ----------------------------------------- */

/*
 * Actual game distribution (from hytale-downloader.zip):
 *   Server/HytaleServer.jar        — main server JAR
 *   Server/HytaleServer.aot.config — JVM AOT config (alongside JAR)
 *   Assets.zip                     — ~3.4 GB shared asset bundle
 *
 * Node-side paths (bind-mounted read-only into containers at /assets):
 *   /var/lib/conduit/assets/hytale/HytaleServer.jar
 *   /var/lib/conduit/assets/hytale/HytaleServer.aot.config
 *   /var/lib/conduit/assets/hytale/Assets.zip
 *   /var/lib/conduit/assets/hytale/.version
 *   /var/lib/conduit/assets/hytale/downloader      ← hytale-downloader binary
 *   /var/lib/conduit/.hytale-downloader-credentials.json
 *
 * Per-instance writable data: /opt/mc/data/ (inside CT).
 * The server is invoked:
 *   java @jvm.options -jar /assets/hytale/HytaleServer.jar \
 *     --assets /assets/hytale/Assets.zip \
 *     --backup --backup-dir /opt/mc/data/backups --backup-frequency 30
 */

const HYTALE_ASSETS_NODE = "/var/lib/conduit/assets/hytale";
const HYTALE_WORKDIR_NODE = "/var/lib/conduit"; // downloader saves creds relative to cwd
const HYTALE_DOWNLOADER_NODE = `${HYTALE_ASSETS_NODE}/downloader`;
const HYTALE_CREDS_NODE = `${HYTALE_WORKDIR_NODE}/.hytale-downloader-credentials.json`;
const HYTALE_DOWNLOADER_ZIP_URL = "https://downloader.hytale.com/hytale-downloader.zip";
// Local credentials file written by the downloader on this machine (next to where it ran)
const HYTALE_CREDS_LOCAL =
  process.env.HYTALE_CREDENTIALS_PATH ?? "/tmp/.hytale-downloader-credentials.json";

/** Upload a local file to a remote path via base64-over-SSH (works for files up to ~50 MB). */
async function sshUpload(localPath: string, remotePath: string, host: string): Promise<void> {
  const content = await readFile(localPath);
  const b64 = content.toString("base64");
  await ssh(
    `mkdir -p "$(dirname '${remotePath}')" && ` +
    `printf '%s' '${b64}' | base64 -d > '${remotePath}.tmp' && ` +
    `mv '${remotePath}.tmp' '${remotePath}'`,
    60_000, host,
  );
}

/** Bootstrap the downloader binary on the node if missing. */
async function ensureDownloaderOnNode(vmid: number, host: string): Promise<void> {
  const ok = (await ssh(`[ -x '${HYTALE_DOWNLOADER_NODE}' ] && echo yes || echo no`, 5_000, host)).trim();
  if (ok === "yes") return;
  pushInstallLog(vmid, `[conduit] uploading hytale-downloader to node ${host}`);
  await ssh(
    `apt-get install -y -qq unzip curl >/dev/null 2>&1 || true && ` +
    `mkdir -p '${HYTALE_ASSETS_NODE}' && ` +
    `cd /tmp && curl -fsSL -o hytale-dl.zip '${HYTALE_DOWNLOADER_ZIP_URL}' && ` +
    `unzip -o hytale-dl.zip hytale-downloader-linux-amd64 && ` +
    `chmod +x hytale-downloader-linux-amd64 && ` +
    `mv hytale-downloader-linux-amd64 '${HYTALE_DOWNLOADER_NODE}' && ` +
    `rm hytale-dl.zip`,
    120_000, host, vmid,
  );
}

/** Copy local OAuth credentials to the node if missing. */
async function ensureCredsOnNode(vmid: number, host: string): Promise<void> {
  const ok = (await ssh(`[ -f '${HYTALE_CREDS_NODE}' ] && echo yes || echo no`, 5_000, host)).trim();
  if (ok === "yes") return;
  let credsJson: string;
  try {
    credsJson = await readFile(HYTALE_CREDS_LOCAL, "utf8");
  } catch {
    pushInstallLog(vmid, `[conduit] WARNING: Hytale credentials not found at ${HYTALE_CREDS_LOCAL}`);
    pushInstallLog(vmid, `[conduit] Authenticate once by running:`);
    pushInstallLog(vmid, `[conduit]   cd /tmp && ./hytale-downloader-linux-amd64 -print-version`);
    pushInstallLog(vmid, `[conduit] Then re-trigger provisioning to auto-upload credentials.`);
    throw new Error("Hytale credentials not found — authenticate first");
  }
  const b64 = Buffer.from(credsJson).toString("base64");
  await ssh(
    `printf '%s' '${b64}' | base64 -d > '${HYTALE_CREDS_NODE}.tmp' && ` +
    `mv '${HYTALE_CREDS_NODE}.tmp' '${HYTALE_CREDS_NODE}' && chmod 600 '${HYTALE_CREDS_NODE}'`,
    10_000, host,
  );
  pushInstallLog(vmid, `[conduit] Hytale credentials uploaded to node`);
}

/**
 * Ensures the Hytale JAR + Assets.zip are present on the host node, downloading
 * (or upgrading) via the official hytale-downloader when the version is stale.
 * Credentials are auto-bootstrapped from the local machine on first run.
 */
async function ensureHytaleAssets(vmid: number, sw: Software, host: string): Promise<void> {
  await ssh(`mkdir -p '${HYTALE_ASSETS_NODE}'`, 10_000, host);

  pushInstallLog(vmid, `[conduit] bootstrapping hytale-downloader on node ${host}`);
  await ensureDownloaderOnNode(vmid, host);
  await ensureCredsOnNode(vmid, host);

  const patchline = sw.version === "pre-release" ? "pre-release" : "release";
  const runDl = `cd '${HYTALE_WORKDIR_NODE}' && '${HYTALE_DOWNLOADER_NODE}' -skip-update-check`;

  // Query latest available version via downloader on node.
  pushInstallLog(vmid, `[conduit] querying latest hytale version (${patchline} patchline)`);
  const latestVersion = (await ssh(
    `${runDl} -print-version -patchline ${patchline} 2>/dev/null || echo ""`,
    30_000, host,
  )).trim();

  const installedVersion = (await ssh(
    `cat '${HYTALE_ASSETS_NODE}/.version' 2>/dev/null || echo ""`,
    5_000, host,
  )).trim();

  const jarExists = (await ssh(
    `[ -f '${HYTALE_ASSETS_NODE}/HytaleServer.jar' ] && echo yes || echo no`,
    5_000, host,
  )).trim() === "yes";

  if (jarExists && installedVersion && installedVersion === latestVersion) {
    pushInstallLog(vmid, `[conduit] hytale assets up-to-date — version ${installedVersion}`);
    return;
  }

  if (!latestVersion) {
    if (jarExists) {
      pushInstallLog(vmid, `[conduit] hytale JAR present (version check failed, using existing ${installedVersion || "unknown"})`);
      return;
    }
    throw new Error("Hytale: version check failed and no JAR present — cannot provision");
  }

  const action = installedVersion ? `upgrading ${installedVersion} → ${latestVersion}` : `downloading ${latestVersion}`;
  pushInstallLog(vmid, `[conduit] hytale: ${action} (this may take several minutes — ~1.4 GB)`);

  const GAME_ZIP = `/tmp/hytale-game.zip`;
  await ssh(
    `${runDl} -download-path '${GAME_ZIP}' -patchline ${patchline}`,
    1_800_000, // 30 min for 1.4 GB
    host, vmid,
  );

  pushInstallLog(vmid, `[conduit] extracting HytaleServer.jar + Assets.zip from downloaded zip`);
  await ssh(
    `cd /tmp && rm -rf hytale-extract && mkdir hytale-extract && ` +
    `unzip -o '${GAME_ZIP}' 'Server/HytaleServer.jar' 'Server/HytaleServer.aot.config' 'Assets.zip' -d hytale-extract/ && ` +
    `mv hytale-extract/Server/HytaleServer.jar '${HYTALE_ASSETS_NODE}/HytaleServer.jar' && ` +
    `mv hytale-extract/Server/HytaleServer.aot.config '${HYTALE_ASSETS_NODE}/HytaleServer.aot.config' && ` +
    `mv hytale-extract/Assets.zip '${HYTALE_ASSETS_NODE}/Assets.zip' && ` +
    `printf '%s' '${latestVersion}' > '${HYTALE_ASSETS_NODE}/.version' && ` +
    `rm -rf hytale-extract '${GAME_ZIP}'`,
    600_000, host, vmid,
  );

  pushInstallLog(vmid, `[conduit] hytale assets ready — ${latestVersion}`);
}

const HYTALE_DIR = "/opt/hytale";

function hytaleScript(vmid: number, task: Task): string {
  const mem = heap(task.memory, 1024, 2048);
  // Source the connector identity (CONDUIT_*) so the conduit-hytale mod reports players.
  const unit = sysdUnit(`Conduit Hytale (${task.name})`, `${HYTALE_DIR}/start.sh`, HYTALE_DIR, true);
  return `set -e
DIR=${HYTALE_DIR}
mkdir -p "$DIR/data/backups" "$DIR/data/mods" "$DIR/logs"
${connectorEnvScript(vmid, task)}
if [ -f "$DIR/.conduit-ready" ]; then echo "already-provisioned"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tmux >/dev/null
${javaInstall(25)}

echo "[conduit] Setting up Hytale instance: ${task.name}"

# JVM memory (write once; operator can edit ${HYTALE_DIR}/jvm.options to tune)
if [ ! -f "$DIR/jvm.options" ]; then
cat > "$DIR/jvm.options" <<'EOF'
-Xms512M
-Xmx${mem}M
EOF
fi

cat > "$DIR/start.sh" <<'STARTSCRIPT'
#!/bin/bash
JAR=/assets/hytale/HytaleServer.jar
if [ ! -f "$JAR" ]; then
  echo "[conduit] HytaleServer.jar not found at $JAR — waiting for assets to appear..."
  sleep 30; exit 1
fi
cd ${HYTALE_DIR}/data
JVM_OPTS=""
[ -f ${HYTALE_DIR}/jvm.options ] && JVM_OPTS="@${HYTALE_DIR}/jvm.options"
exec ${JAVA_BIN} $JVM_OPTS -jar "$JAR" \\
  --assets /assets/hytale/Assets.zip \\
  --backup --backup-dir ${HYTALE_DIR}/data/backups --backup-frequency 30
STARTSCRIPT
chmod +x "$DIR/start.sh"

cat > /etc/systemd/system/mc.service <<'UNIT'
${unit}
UNIT
systemctl daemon-reload
systemctl enable mc >/dev/null 2>&1 || true
systemctl start mc || true

touch "$DIR/.conduit-ready"
echo CONDUIT_PROVISIONED_HYTALE
`;
}

export async function installHytale(vmid: number, task: Task, sw: Software, host?: string): Promise<void> {
  const h = host ?? SSH_HOST;
  await ensureHytaleAssets(vmid, sw, h);
  await ctExec(vmid, hytaleScript(vmid, task), 180_000, host);
}

/* ---- nginx (web server) -------------------------------------------------- */

function nginxScript(): string {
  // tmux gives the Console tab a real shell in the container; /opt/nginx symlinks the config
  // into the /opt files sandbox so the file manager can edit nginx.conf etc. (docroot = /opt/www).
  const shellUnit = `[Unit]
Description=Conduit nginx shell (tmux)
After=network-online.target
[Service]
Type=forking
WorkingDirectory=/opt/www
ExecStart=/usr/bin/tmux -L mc new-session -d -s mc -x 220 -y 50
ExecStop=/usr/bin/tmux -L mc kill-session -t mc
RemainAfterExit=yes
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target`;
  return `set -e
if [ -f /opt/.conduit-ready ]; then echo already-provisioned; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y -qq nginx tmux >/dev/null
mkdir -p /opt/www
# expose nginx config inside the /opt files sandbox (file manager can't see /etc)
[ -e /opt/nginx ] || ln -s /etc/nginx /opt/nginx
if [ ! -f /opt/www/index.html ]; then
cat > /opt/www/index.html <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8"><title>Conduit · nginx</title>
<style>body{background:#16191e;color:#c9d1d9;font-family:ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}
.c{text-align:center}.b{color:#7c83ff;font-weight:700;font-size:28px}</style></head>
<body><div class="c"><div class="b">Conduit · nginx</div>
<p>Your web service is live. Edit <code>/opt/www</code> (or the egg template) to publish your site.</p></div></body></html>
HTML
fi
cat > /etc/nginx/sites-available/default <<'NGINX'
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  root /opt/www;
  index index.html index.htm;
  location / { try_files $uri $uri/ =404; }
}
NGINX
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx
# tmux shell session for the Console tab
cat > /etc/systemd/system/mc.service <<'UNIT'
${shellUnit}
UNIT
systemctl daemon-reload
systemctl enable mc >/dev/null 2>&1 || true
systemctl start mc || true
touch /opt/.conduit-ready
echo CONDUIT_PROVISIONED_NGINX
`;
}

export async function installNginx(vmid: number, host?: string): Promise<void> {
  await ctExec(vmid, nginxScript(), 240_000, host);
}

/* ---- Velocity (proxy) ---------------------------------------------------- */

function velocityScript(task: Task, secret: string, build: Resolved, vmid: number): string {
  const mem = heap(task.memory, 512, 512);
  const unit = sysdUnit(
    `Conduit Velocity (${task.name})`,
    `${JAVA_BIN} -Xms256M -Xmx${mem}M -jar velocity.jar`,
    "/opt/mc",
    true,
  );
  return `set -e
MCDIR=/opt/mc
mkdir -p "$MCDIR"
if [ -f "$MCDIR/.conduit-ready" ]; then echo "already-provisioned"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tmux >/dev/null
${javaInstall(build.javaMajor)}
echo "velocity jar (java ${build.javaMajor})"
curl -fsSL -o "$MCDIR/velocity.jar" '${build.jarUrl}'
printf '%s' '${secret}' > "$MCDIR/forwarding.secret"
cat > /etc/systemd/system/mc.service <<'UNIT'
${unit}
UNIT
${connectorEnvScript(vmid, task)}
systemctl daemon-reload
systemctl enable mc >/dev/null 2>&1 || true
systemctl start mc
touch "$MCDIR/.conduit-ready"
echo CONDUIT_PROVISIONED_VELOCITY
`;
}

export async function installVelocity(
  vmid: number,
  task: Task,
  secret: string,
  version = "3.3.0-SNAPSHOT",
  host?: string,
): Promise<void> {
  const build = await resolveBuild("velocity", version);
  await ctExec(vmid, velocityScript(task, secret, build, vmid), 360_000, host);
}

/** Default MOTD for a task when none is set (MiniMessage format for Velocity). */
export const defaultMotd = (name: string) => `Conduit <aqua>${name}</aqua>`;

/** Translate '&' colour codes to the section sign Paper/legacy servers expect. */
const colorize = (s: string) => s.replace(/&([0-9a-fk-or])/gi, "§$1");

// legacy code → MiniMessage tag (Velocity 3.x parses its MOTD as MiniMessage, not legacy).
const MINI: Record<string, string> = {
  "0": "black", "1": "dark_blue", "2": "dark_green", "3": "dark_aqua",
  "4": "dark_red", "5": "dark_purple", "6": "gold", "7": "gray",
  "8": "dark_gray", "9": "blue", a: "green", b: "aqua", c: "red",
  d: "light_purple", e: "yellow", f: "white",
  l: "bold", o: "italic", n: "underlined", m: "strikethrough", k: "obfuscated", r: "reset",
};
/** Convert legacy '&' or '§' coded strings to MiniMessage for Velocity 3.x. */
function miniMessage(s: string): string {
  return s
    .replace(/[&§]([0-9a-fk-or])/gi, (_, c) => `<${MINI[c.toLowerCase()]}>`)
    .replace(/\n/g, "<newline>");
}

/**
 * Reload a Velocity proxy's config live, WITHOUT disconnecting players.
 *
 * Velocity 3.4.0 ships the `velocity reload` console command (re-reads velocity.toml:
 * MOTD, [servers], try-list, forced-hosts, …). We drive it through the tmux session.
 * Falls back to a service restart only when the session isn't up yet (fresh CT).
 */
export async function velocityReload(vmid: number, host?: string): Promise<void> {
  try {
    const out = await ctExec(
      vmid,
      `if tmux -L mc has-session -t mc 2>/dev/null; then ` +
        `tmux -L mc send-keys -t mc "velocity reload" Enter; echo RELOADED; ` +
        `else echo NOSESSION; fi`,
      30_000,
      host,
    );
    if (out.includes("NOSESSION")) {
      await ctExec(vmid, `systemctl restart mc`, 60_000, host);
    }
  } catch {
    await ctExec(vmid, `systemctl restart mc`, 60_000, host);
  }
}

/**
 * Update a running server's MOTD without a full reinstall.
 * Paper → server.properties `motd=` + restart; Velocity → velocity.toml `motd =`
 * + live `velocity reload` (no player kicks).
 */
export async function setMotd(vmid: number, role: string, motd: string, host?: string): Promise<void> {
  // Files want a LITERAL \n for line breaks; but GNU sed turns \n in its replacement
  // into a real newline, so we feed sed \\n (which it emits as the literal \n we want).
  const m = colorize(motd).replace(/\n/g, "\\\\n");
  if (role === "proxy") {
    const v = m.replace(/"/g, '\\"');
    await ctExec(
      vmid,
      `sed -i 's#^motd = .*#motd = "${v}"#' /opt/mc/velocity.toml`,
      60_000,
      host,
    );
    await velocityReload(vmid, host);
  } else {
    const p = m.replace(/#/g, "\\#");
    await ctExec(
      vmid,
      `sed -i 's#^motd=.*#motd=${p}#' /opt/mc/server.properties && systemctl restart mc`,
      60_000,
      host,
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
// Stored on `global` so hot-reloads don't forget it and restart Velocity needlessly.
declare global { var __conduitLastSig: Map<number, string> | undefined; }
if (!global.__conduitLastSig) global.__conduitLastSig = new Map();
const lastSig = global.__conduitLastSig;

/** Push the live backend list into a proxy's velocity.toml and restart Velocity to apply it. */
export async function syncVelocity(
  vmid: number,
  task: Task,
  servers: ProxyServer[],
  host?: string,
): Promise<boolean> {
  const sig = servers
    .map((s) => `${s.name}=${s.ip}:${s.port}`)
    .sort()
    .join(",");
  if (lastSig.get(vmid) === sig) return false;

  const newToml = velocityToml(task, servers);

  // Before restarting Velocity (which disconnects players), check if the file on
  // disk is already identical — handles hot-reload losing lastSig without kicking players.
  let existing = "";
  try {
    existing = await ssh(
      `pct exec ${vmid} -- cat /opt/mc/velocity.toml`,
      10_000,
      host ?? SSH_HOST,
    );
  } catch { /* CT not running yet, proceed */ }

  if (existing.trim() === newToml.trim()) {
    lastSig.set(vmid, sig); // re-cache so we don't check again next tick
    return false;
  }

  await ctWrite(vmid, "/opt/mc/velocity.toml", newToml, host);
  // Velocity 3.4.0 has a working `velocity reload` — apply the new backend list LIVE
  // without disconnecting players. Falls back to a restart only if the session is down.
  await velocityReload(vmid, host);

  lastSig.set(vmid, sig);
  return true;
}

export function forgetVelocity(vmid: number): void {
  lastSig.delete(vmid);
}
