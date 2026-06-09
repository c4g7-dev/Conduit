package dev.c4g7.conduit.paper;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Tiny dependency-free Redis (RESP) client for player-data sync. Conduit ships no Redis library
 * into the connector, so this speaks just enough RESP — AUTH / SETEX / GET / DEL — over a short
 * per-op connection. The endpoint list comes from the panel (primary first); each op tries the
 * list in order and uses the first that answers, so losing the primary fails over to a replica
 * automatically. Handoffs are infrequent, so per-op connects keep it simple and robust.
 */
final class RedisClient {
    private volatile List<String> endpoints;
    private volatile String password;

    RedisClient(List<String> endpoints, String password) {
        this.endpoints = endpoints;
        this.password = password;
    }

    void configure(List<String> endpoints, String password) {
        this.endpoints = endpoints;
        this.password = password;
    }

    boolean available() { return endpoints != null && !endpoints.isEmpty(); }

    void setex(String key, int seconds, String value) {
        run(s -> command(s, "SETEX", key, Integer.toString(seconds), value));
    }

    String get(String key) {
        return run(s -> command(s, "GET", key));
    }

    void del(String key) {
        run(s -> command(s, "DEL", key));
    }

    /* ---- transport ---- */

    private interface Op { String apply(Socket s) throws IOException; }

    private String run(Op op) {
        List<String> eps = endpoints;
        if (eps == null) return null;
        for (String ep : eps) {
            int c = ep.lastIndexOf(':');
            if (c < 0) continue;
            String host = ep.substring(0, c);
            int port;
            try { port = Integer.parseInt(ep.substring(c + 1)); } catch (NumberFormatException e) { continue; }
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(host, port), 1500);
                s.setSoTimeout(2500);
                if (password != null && !password.isEmpty()) command(s, "AUTH", password);
                return op.apply(s);
            } catch (IOException ignored) {
                // try the next endpoint (failover)
            }
        }
        return null;
    }

    /** Send a RESP command and read one reply (simple/bulk/int/error). Returns the bulk/simple value. */
    private static String command(Socket s, String... args) throws IOException {
        OutputStream out = s.getOutputStream();
        // RESP array: *N then $len + arg for each (base64/UTF-8 args are binary-safe here).
        out.write(("*" + args.length + "\r\n").getBytes(StandardCharsets.UTF_8));
        for (String a : args) {
            byte[] b = a.getBytes(StandardCharsets.UTF_8);
            out.write(("$" + b.length + "\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(b);
            out.write('\r'); out.write('\n');
        }
        out.flush();
        return readReply(new BufferedInputStream(s.getInputStream()));
    }

    private static String readReply(InputStream in) throws IOException {
        int type = in.read();
        if (type < 0) throw new IOException("eof");
        switch (type) {
            case '+': return readLine(in);           // simple string
            case '-': readLine(in); return null;     // error → null
            case ':': return readLine(in);           // integer
            case '$': {                              // bulk string
                int len = Integer.parseInt(readLine(in));
                if (len < 0) return null;
                byte[] buf = in.readNBytes(len);
                in.read(); in.read();                // trailing \r\n
                return new String(buf, StandardCharsets.UTF_8);
            }
            default: readLine(in); return null;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\r') { in.read(); break; } // consume \n
            sb.append((char) c);
        }
        return sb.toString();
    }
}
