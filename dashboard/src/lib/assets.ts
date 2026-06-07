/**
 * Shared asset store on the Proxmox node — uploaded worlds/plugins/configs that
 * tasks reference in their seed (instead of needing a public URL).
 *
 * Files live under CONDUIT_ASSETS_DIR on the node (default /var/lib/conduit/assets,
 * with worlds/ and plugins/ subdirs). The dashboard reads/writes them over SSH as
 * root (same key as provisioning). At provision time the engine `pct push`es a
 * referenced asset into the target container (see engine.ts), so this works for
 * Minecraft containers without the Hytale-style read-only /assets bind mount.
 */
import { spawn } from "node:child_process";

const SSH_HOST = process.env.PROXMOX_SSH_HOST ?? process.env.PROXMOX_HOST ?? "10.27.27.126";
const SSH_USER = process.env.PROXMOX_SSH_USER ?? "root";
const SSH_KEY = process.env.PROXMOX_SSH_KEY ?? "";
const SSH_PASS = process.env.PROXMOX_SSH_PASS ?? process.env.PROXMOX_PASS ?? "";

export const ASSETS_DIR = process.env.CONDUIT_ASSETS_DIR ?? "/var/lib/conduit/assets";
export const ASSET_SCHEME = "conduit-asset:"; // seed reference prefix

/** Run a command on the node; optionally pipe `input` to its stdin. */
function nodeRun(remote: string, input?: Buffer, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=ERROR",
    ];
    let cmd: string, args: string[];
    if (SSH_KEY) {
      cmd = "ssh";
      args = ["-i", SSH_KEY, "-o", "BatchMode=yes", ...opts, `${SSH_USER}@${SSH_HOST}`, remote];
    } else {
      cmd = "sshpass";
      args = ["-p", SSH_PASS, "ssh", ...opts, `${SSH_USER}@${SSH_HOST}`, remote];
    }
    const p = spawn(cmd, args);
    let out = "", err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`ssh exit ${code}: ${(err || out).slice(-300)}`));
    });
    if (input) { p.stdin.write(input); p.stdin.end(); }
  });
}

const KINDS = ["worlds", "plugins", "configs"] as const;
export type AssetKind = (typeof KINDS)[number];
const safe = (s: string) => /^[\w.\- ]+$/.test(s); // no slashes / traversal

export type Asset = { kind: AssetKind; name: string; path: string; size: number; ref: string };

/** List all uploaded assets under the store. */
export async function listAssets(): Promise<Asset[]> {
  const out = await nodeRun(
    `for d in ${KINDS.join(" ")}; do for f in "${ASSETS_DIR}/$d"/*; do [ -f "$f" ] && printf '%s\\t%s\\n' "$d/$(basename "$f")" "$(stat -c%s "$f")"; done; done 2>/dev/null || true`,
  ).catch(() => "");
  const assets: Asset[] = [];
  for (const line of out.split("\n")) {
    const [rel, size] = line.split("\t");
    if (!rel) continue;
    const [kind, name] = rel.split("/");
    assets.push({
      kind: kind as AssetKind,
      name,
      path: `${ASSETS_DIR}/${rel}`,
      size: Number(size) || 0,
      ref: `${ASSET_SCHEME}${rel}`,
    });
  }
  return assets;
}

/** Store an uploaded file under <kind>/<name> on the node. */
export async function putAsset(kind: string, name: string, data: Buffer): Promise<Asset> {
  if (!KINDS.includes(kind as AssetKind)) throw new Error("invalid kind");
  if (!safe(name)) throw new Error("invalid filename");
  const dir = `${ASSETS_DIR}/${kind}`;
  const dest = `${dir}/${name}`;
  await nodeRun(`mkdir -p '${dir}' && base64 -d > '${dest}' && chmod a+rX '${dest}'`, Buffer.from(data.toString("base64")));
  return { kind: kind as AssetKind, name, path: dest, size: data.length, ref: `${ASSET_SCHEME}${kind}/${name}` };
}

/** Delete an asset by its `kind/name` relative path. */
export async function deleteAsset(rel: string): Promise<void> {
  const [kind, name] = rel.split("/");
  if (!KINDS.includes(kind as AssetKind) || !safe(name ?? "")) throw new Error("invalid asset");
  await nodeRun(`rm -f '${ASSETS_DIR}/${kind}/${name}'`);
}

/** Resolve a seed reference: a `conduit-asset:` ref → the node file path, else null. */
export function assetNodePath(ref: string): string | null {
  if (!ref.startsWith(ASSET_SCHEME)) return null;
  const rel = ref.slice(ASSET_SCHEME.length);
  const [kind, name] = rel.split("/");
  if (!KINDS.includes(kind as AssetKind) || !safe(name ?? "")) return null;
  return `${ASSETS_DIR}/${kind}/${name}`;
}
