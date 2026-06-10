/**
 * Conduit Console Proxy
 * =====================
 * Runs inside each panel LXC. Bridges a browser WebSocket (xterm.js terminal) to the
 * per-node conduit-agent's console WebSocket, injecting the agent token SERVER-SIDE so it
 * never reaches the browser. This is what gives the panel a Pelican/Wings-class terminal
 * (real-time, single echo) — Next.js standalone can't host a WS route, hence this tiny
 * dedicated service on its own port.
 *
 *   browser  ws://<panel>:8801/console?vmid=<id>&agent=<nodeIp>
 *      └─ proxy ─ ws://<nodeIp>:8800/v1/console?vmid=<id>&token=<AGENT_TOKEN>
 *
 * Frames are relayed verbatim in both directions (the agent already speaks the
 * {type,data} JSON the xterm client expects). The target agent IP is validated against
 * CONDUIT_NODES so a browser can't aim the token at an arbitrary host.
 *
 * Env: CONDUIT_AGENT_TOKEN, CONDUIT_AGENT_PORT (8800), CONDUIT_NODES (csv of allowed
 *      agent IPs), CONDUIT_CONSOLE_PORT (8801).
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const TOKEN = process.env.CONDUIT_AGENT_TOKEN || "";
const AGENT_PORT = Number(process.env.CONDUIT_AGENT_PORT || 8800);
const PORT = Number(process.env.CONDUIT_CONSOLE_PORT || 8801);
const ALLOWED = new Set(
  (process.env.CONDUIT_NODES || "").split(",").map((s) => s.trim()).filter(Boolean),
);

if (!TOKEN) {
  console.error("[console-proxy] FATAL: CONDUIT_AGENT_TOKEN not set");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, nodes: [...ALLOWED] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/console") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const vmid = Number(url.searchParams.get("vmid"));
  const agent = url.searchParams.get("agent") || "";
  if (!Number.isInteger(vmid) || !agent || (ALLOWED.size && !ALLOWED.has(agent))) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => bridge(client, vmid, agent));
});

function bridge(client, vmid, agent) {
  const target = `ws://${agent}:${AGENT_PORT}/v1/console?vmid=${vmid}&token=${encodeURIComponent(TOKEN)}`;
  const upstream = new WebSocket(target);
  const queue = [];

  upstream.on("open", () => {
    for (const m of queue) upstream.send(m);
    queue.length = 0;
  });
  // agent → browser
  upstream.on("message", (d) => {
    if (client.readyState === client.OPEN) client.send(d.toString());
  });
  upstream.on("close", () => { try { client.close(); } catch {} });
  upstream.on("error", () => { try { client.close(); } catch {} });

  // browser → agent
  client.on("message", (d) => {
    const m = d.toString();
    if (upstream.readyState === upstream.OPEN) upstream.send(m);
    else queue.push(m);
  });
  client.on("close", () => { try { upstream.close(); } catch {} });
  client.on("error", () => { try { upstream.close(); } catch {} });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[console-proxy] listening on 0.0.0.0:${PORT} → agents :${AGENT_PORT} (${[...ALLOWED].join(", ") || "any"})`);
});
