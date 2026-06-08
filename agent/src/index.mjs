/**
 * Conduit Node Agent
 * ==================
 * Runs as a systemd service ON a Proxmox host (NOT inside an LXC) — `pct` requires
 * host-level cluster access. This is the same model as Pterodactyl's Wings daemon.
 *
 * Exposes, behind a shared bearer token:
 *   GET  /v1/health                  → node identity + container count
 *   POST /v1/exec                    → run a command (optionally inside a CT via pct exec)
 *   WS   /v1/console?vmid=&token=    → real-time bidirectional console for a CT's tmux session
 *
 * Console streaming uses tmux `pipe-pane` to append live pane output to a log file
 * inside the container, then `tail -F` streams it over the socket — true real-time,
 * no polling, and no native PTY module to compile on the host.
 *
 * Config via env (see /etc/conduit/agent.env):
 *   CONDUIT_AGENT_TOKEN   shared secret (required)
 *   CONDUIT_AGENT_PORT    listen port (default 8800)
 *   CONDUIT_AGENT_HOST    bind address (default 0.0.0.0)
 *   CONDUIT_TMUX_SOCKET   tmux socket name used by services (default "mc")
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, rename, readdir, stat, rm, cp } from "node:fs/promises";
import { resolve as pathResolve, dirname, basename } from "node:path";
import os from "node:os";
import { WebSocketServer } from "ws";

const TOKEN = process.env.CONDUIT_AGENT_TOKEN || "";
const PORT = Number(process.env.CONDUIT_AGENT_PORT || 8800);
const BIND = process.env.CONDUIT_AGENT_HOST || "0.0.0.0";
const TMUX = process.env.CONDUIT_TMUX_SOCKET || "mc";
const CONSOLE_LOG = "/tmp/conduit-console.log"; // inside each container
// Shared Conduit state lives on the corosync-replicated cluster FS so every node's
// agent (and thus every panel LXC) reads/writes one consistent copy.
const STATE_DIR = process.env.CONDUIT_STATE_DIR || "/etc/pve/conduit";
const STATE_FILE = `${STATE_DIR}/conduit.json`;
const VERSION = "0.1.0";

if (!TOKEN) {
  console.error("[agent] FATAL: CONDUIT_AGENT_TOKEN is not set");
  process.exit(1);
}

/* ---- helpers -------------------------------------------------------------- */

/** Run a command, capturing stdout/stderr. Resolves with { code, stdout, stderr }. */
function run(cmd, args, { timeoutMs = 30_000, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input != null) {
      p.stdin.write(input);
      p.stdin.end();
    }
  });
}

/** pct exec wrapper: runs `bash -c <script>` inside a container. */
function pctExec(vmid, script, timeoutMs = 30_000) {
  return run("pct", ["exec", String(vmid), "--", "bash", "-c", script], { timeoutMs });
}

function authOk(req, url) {
  const header = req.headers["authorization"];
  if (header === `Bearer ${TOKEN}`) return true;
  if (url && url.searchParams.get("token") === TOKEN) return true;
  return false;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

/* ---- File manager (sandboxed to the shared store) ------------------------- */

const FS_ROOT = process.env.CONDUIT_STATE_DIR
  ? process.env.CONDUIT_STATE_DIR.replace(/\/conduit$/, "/conduit") // tolerate either
  : "/var/lib/conduit";
const FS_MAX = 2 * 1024 * 1024; // 2 MB editable cap

/** Resolve a requested path and ensure it stays within FS_ROOT (no traversal). */
function safePath(rel) {
  const p = pathResolve(FS_ROOT, "." + ("/" + (rel || "")).replace(/\/+/g, "/"));
  if (p !== FS_ROOT && !p.startsWith(FS_ROOT + "/")) return null;
  return p;
}

async function handleFs(req, res, url) {
  const sub = url.pathname.slice("/v1/fs".length); // "", "/read", "/write", "/mkdir", "/delete"
  try {
    if (req.method === "GET" && (sub === "" || sub === "/list")) {
      const p = safePath(url.searchParams.get("path") || "");
      if (!p) return json(res, 400, { error: "bad path" });
      const entries = await readdir(p, { withFileTypes: true });
      const rows = await Promise.all(entries.map(async (e) => {
        let size = 0, mtime = 0;
        try { const s = await stat(pathResolve(p, e.name)); size = s.size; mtime = Math.round(s.mtimeMs); } catch {}
        return { name: e.name, type: e.isDirectory() ? "dir" : "file", size, mtime };
      }));
      rows.sort((a, b) => (b.type === "dir" ? 1 : 0) - (a.type === "dir" ? 1 : 0) || a.name.localeCompare(b.name));
      return json(res, 200, { path: p, entries: rows });
    }
    if (req.method === "GET" && sub === "/read") {
      const p = safePath(url.searchParams.get("path") || "");
      if (!p) return json(res, 400, { error: "bad path" });
      const s = await stat(p);
      const buf = await readFile(p);
      return json(res, 200, { path: p, size: s.size, truncated: s.size > FS_MAX, content: buf.slice(0, FS_MAX).toString("utf8") });
    }
    if (req.method === "PUT" && sub === "/write") {
      const { path, content } = JSON.parse(await readBody(req));
      const p = safePath(path);
      if (!p) return json(res, 400, { error: "bad path" });
      await mkdir(pathResolve(p, ".."), { recursive: true });
      await writeFile(p, String(content ?? ""));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && sub === "/mkdir") {
      const { path } = JSON.parse(await readBody(req));
      const p = safePath(path);
      if (!p) return json(res, 400, { error: "bad path" });
      await mkdir(p, { recursive: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && sub === "/delete") {
      // Accept a single path or a list of paths (batch delete).
      const body = JSON.parse(await readBody(req));
      const list = Array.isArray(body.paths) ? body.paths : [body.path];
      for (const rel of list) {
        const p = safePath(rel);
        if (!p || p === FS_ROOT) continue;
        await rm(p, { recursive: true, force: true });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && (sub === "/move" || sub === "/copy")) {
      const { from, to } = JSON.parse(await readBody(req));
      const a = safePath(from), b = safePath(to);
      if (!a || !b || a === FS_ROOT) return json(res, 400, { error: "bad path" });
      await mkdir(dirname(b), { recursive: true });
      if (sub === "/move") await rename(a, b);
      else await cp(a, b, { recursive: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && sub === "/upload") {
      // body: { dir, name, content (base64) }
      const { dir, name, content } = JSON.parse(await readBody(req));
      const safeName = String(name || "").replace(/[/\\]/g, "");
      const d = safePath(dir);
      if (!d || !safeName) return json(res, 400, { error: "bad path" });
      await mkdir(d, { recursive: true });
      await writeFile(pathResolve(d, safeName), Buffer.from(String(content || ""), "base64"));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && sub === "/archive") {
      // body: { dir, names[], dest } → zip names (relative to dir) into dest
      const { dir, names, dest } = JSON.parse(await readBody(req));
      const d = safePath(dir), z = safePath(dest);
      if (!d || !z || !Array.isArray(names) || !names.length) return json(res, 400, { error: "bad args" });
      const r = await run("bash", ["-c", `cd ${JSON.stringify(d)} && zip -r -q ${JSON.stringify(z)} ${names.map((n) => JSON.stringify(String(n).replace(/[/\\]/g, ""))).join(" ")}`], { timeoutMs: 300_000 });
      if (r.code !== 0) return json(res, 500, { error: r.stderr || "zip failed" });
      return json(res, 200, { ok: true, dest: z });
    }
    if (req.method === "POST" && sub === "/extract") {
      const { path } = JSON.parse(await readBody(req));
      const p = safePath(path);
      if (!p) return json(res, 400, { error: "bad path" });
      const into = dirname(p);
      const cmd = /\.zip$/i.test(p) ? `unzip -o -q ${JSON.stringify(p)} -d ${JSON.stringify(into)}`
        : /\.(tar\.gz|tgz)$/i.test(p) ? `tar xzf ${JSON.stringify(p)} -C ${JSON.stringify(into)}`
        : `tar xf ${JSON.stringify(p)} -C ${JSON.stringify(into)}`;
      const r = await run("bash", ["-c", cmd], { timeoutMs: 300_000 });
      if (r.code !== 0) return json(res, 500, { error: r.stderr || "extract failed" });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && sub === "/download") {
      const p = safePath(url.searchParams.get("path") || "");
      if (!p) return json(res, 400, { error: "bad path" });
      const s = await stat(p);
      if (s.isDirectory()) {
        // stream a zip of the directory
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${basename(p)}.zip"` });
        const zip = spawn("bash", ["-c", `cd ${JSON.stringify(dirname(p))} && zip -r -q - ${JSON.stringify(basename(p))}`]);
        zip.stdout.pipe(res);
        zip.stderr.on("data", () => {});
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${basename(p)}"`, "Content-Length": String(s.size) });
      createReadStream(p).pipe(res);
      return;
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: String(e) });
  }
}

/* ---- HTTP server ---------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!authOk(req, url)) {
    return json(res, 401, { error: "unauthorized" });
  }

  // GET /v1/health
  if (req.method === "GET" && url.pathname === "/v1/health") {
    const list = await run("pct", ["list"], { timeoutMs: 8_000 });
    const containers = list.stdout
      .split("\n")
      .slice(1)
      .filter((l) => l.trim()).length;
    return json(res, 200, {
      ok: true,
      version: VERSION,
      hostname: os.hostname(),
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      containers,
    });
  }

  // GET /v1/state → shared Conduit state JSON ({} if not created yet)
  if (req.method === "GET" && url.pathname === "/v1/state") {
    try {
      const raw = await readFile(STATE_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(raw);
    } catch {
      return json(res, 200, {}); // not created yet
    }
    return;
  }

  // PUT /v1/state → atomically replace shared Conduit state JSON
  if (req.method === "PUT" && url.pathname === "/v1/state") {
    const body = await readBody(req);
    try {
      JSON.parse(body); // validate it's JSON before persisting
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    try {
      await mkdir(STATE_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, STATE_FILE); // atomic on same fs
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: String(e) });
    }
  }

  // POST /v1/exec  { vmid?, cmd, timeoutMs? }
  if (req.method === "POST" && url.pathname === "/v1/exec") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const { vmid, cmd, timeoutMs } = payload || {};
    if (typeof cmd !== "string" || !cmd.trim()) {
      return json(res, 400, { error: "cmd required" });
    }
    const result = vmid
      ? await pctExec(vmid, cmd, timeoutMs || 30_000)
      : await run("bash", ["-c", cmd], { timeoutMs: timeoutMs || 30_000 });
    return json(res, 200, result);
  }

  // ---- File manager over the shared store (sandboxed to CONDUIT_ROOT) ----
  if (url.pathname.startsWith("/v1/fs")) {
    return handleFs(req, res, url);
  }

  return json(res, 404, { error: "not found" });
});

/* ---- WebSocket console ---------------------------------------------------- */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/v1/console" || !authOk(req, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const vmid = Number(url.searchParams.get("vmid"));
  if (!Number.isInteger(vmid)) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachConsole(ws, vmid));
});

async function attachConsole(ws, vmid) {
  const send = (type, data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
  };

  // 1. Ensure pipe-pane is streaming live pane output to the in-container log.
  //    `pipe-pane -O` opens the pipe (replacing any existing one) so we always have a fresh stream.
  await pctExec(
    vmid,
    `tmux -L ${TMUX} pipe-pane -O -t ${TMUX} 'cat >> ${CONSOLE_LOG}' 2>/dev/null || true`,
    8_000,
  );

  // 2. Send recent history (current pane buffer, ANSI preserved).
  const hist = await pctExec(
    vmid,
    `tmux -L ${TMUX} capture-pane -p -e -t ${TMUX} -S -500 2>/dev/null || echo '[console] no tmux session yet'`,
    8_000,
  );
  send("history", hist.stdout);

  // 3. Stream new output via tail -F (follow + retry if the file rotates/recreates).
  const tail = spawn("pct", [
    "exec",
    String(vmid),
    "--",
    "tail",
    "-F",
    "-n",
    "0",
    CONSOLE_LOG,
  ]);
  tail.stdout.on("data", (d) => send("output", d.toString("utf8")));
  tail.stderr.on("data", () => {});
  tail.on("close", () => {
    if (ws.readyState === ws.OPEN) send("output", "\n[console] stream ended\n");
  });

  // 4. Inbound: { type: "input", data } → send-keys into the session.
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      const line = msg.data.replace(/[\r\n]+/g, " ");
      const b64 = Buffer.from(line, "utf8").toString("base64");
      await pctExec(
        vmid,
        `tmux -L ${TMUX} send-keys -t ${TMUX} "$(echo ${b64} | base64 -d)" Enter`,
        8_000,
      );
    } else if (msg.type === "ping") {
      send("pong", Date.now());
    }
  });

  ws.on("close", () => {
    tail.kill("SIGKILL");
  });

  send("ready", { vmid });
}

server.listen(PORT, BIND, () => {
  console.log(`[agent] conduit-agent v${VERSION} listening on ${BIND}:${PORT}`);
});
