/**
 * Minecraft Server List Ping (SLP) client — reads live player counts without a
 * plugin. Both Paper backends and the Velocity proxy answer the status handshake
 * over raw TCP, returning {players.online, players.max, players.sample[], motd}.
 *
 * Protocol (post-1.7): connect → send Handshake(next_state=1) + Status Request →
 * read a single length-prefixed packet whose payload is a JSON status object.
 * All lengths are VarInts. See https://minecraft.wiki/w/Java_Edition_protocol
 */
import net from "node:net";

export type PingResult = {
  online: number;
  max: number;
  sample: { name: string; id?: string }[];
  version: string;
  motd: string;
  latencyMs: number;
};

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error("varint: need more data");
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift >= 35) throw new Error("varint too long");
  }
  return [result >>> 0, pos];
}

function withLength(id: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat([writeVarInt(id), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function string(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([writeVarInt(b.length), b]);
}

/** Flatten a Minecraft chat-component MOTD (string | {text, extra[]}) to plain text. */
function flattenMotd(d: unknown): string {
  if (typeof d === "string") return d;
  if (!d || typeof d !== "object") return "";
  const o = d as { text?: string; extra?: unknown[] };
  let out = o.text ?? "";
  if (Array.isArray(o.extra)) out += o.extra.map(flattenMotd).join("");
  return out;
}

/** Status-ping a Minecraft server. Rejects on timeout/refused/parse error. */
export function pingMc(host: string, port: number, timeoutMs = 2500): Promise<PingResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    let buf = Buffer.alloc(0);
    let done = false;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      socket.destroy();
      fn();
    };

    socket.on("connect", () => {
      const handshake = withLength(
        0x00,
        writeVarInt(765), // protocol version — servers ignore it for status
        string(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1), // next state: status
      );
      const statusRequest = withLength(0x00);
      socket.write(Buffer.concat([handshake, statusRequest]));
    });

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        let off = 0;
        const [pktLen, o1] = readVarInt(buf, off);
        off = o1;
        if (buf.length - off < pktLen) return; // packet incomplete
        const [, o2] = readVarInt(buf, off); // packet id (0x00)
        off = o2;
        const [jsonLen, o3] = readVarInt(buf, off);
        off = o3;
        if (buf.length - off < jsonLen) return; // json incomplete
        const json = buf.subarray(off, off + jsonLen).toString("utf8");
        const data = JSON.parse(json);
        finish(() =>
          resolve({
            online: data.players?.online ?? 0,
            max: data.players?.max ?? 0,
            sample: (data.players?.sample ?? []).map((s: { name: string; id?: string }) => ({
              name: s.name,
              id: s.id,
            })),
            version: data.version?.name ?? "",
            motd: flattenMotd(data.description),
            latencyMs: Date.now() - start,
          }),
        );
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("varint")) return; // need more data
        finish(() => reject(e));
      }
    });

    socket.on("timeout", () => finish(() => reject(new Error("timeout"))));
    socket.on("error", (e) => finish(() => reject(e)));
  });
}
