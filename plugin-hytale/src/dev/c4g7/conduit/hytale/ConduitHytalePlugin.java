package dev.c4g7.conduit.hytale;

import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.hypixel.hytale.server.core.plugin.JavaPluginInit;
import com.hypixel.hytale.server.core.event.events.player.PlayerConnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerDisconnectEvent;
import com.hypixel.hytale.server.core.universe.PlayerRef;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Conduit connector for Hytale — the backend reporter (equivalent to the Paper connector).
 * Tracks online players via PlayerConnect/Disconnect events and POSTs register + heartbeat
 * (id/task/group + full player list with name+uuid) to the Conduit panel, so Hytale players
 * appear in the network Players view alongside Minecraft. JDK HttpClient forced to HTTP/1.1
 * (the Node panel mishandles HTTP/2 — same gotcha as the MC connector). Config via env
 * (CONDUIT_ENDPOINT/TOKEN/SERVICE_ID/TASK/GROUP), injected by Conduit at provision.
 */
public class ConduitHytalePlugin extends JavaPlugin {
    private final Map<String, String> players = new ConcurrentHashMap<>(); // uuid -> username
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build();
    private volatile boolean running = true;
    private String endpoint, token, id, task, group;
    private int maxPlayers;

    public ConduitHytalePlugin(JavaPluginInit init) { super(init); }

    @Override
    protected void setup() {
        endpoint = envOr("CONDUIT_ENDPOINT", "http://10.27.27.50:3001").replaceAll("/+$", "");
        token = envOr("CONDUIT_TOKEN", "");
        id = envOr("CONDUIT_SERVICE_ID", "hytale");
        task = envOr("CONDUIT_TASK", "hytale");
        group = envOr("CONDUIT_GROUP", "Network");
        try { maxPlayers = Integer.parseInt(envOr("CONDUIT_MAXPLAYERS", "100")); } catch (Exception e) { maxPlayers = 100; }

        getEventRegistry().register(PlayerConnectEvent.class, (PlayerConnectEvent e) -> {
            PlayerRef r = e.getPlayerRef();
            if (r != null && r.getUuid() != null) {
                players.put(r.getUuid().toString(), r.getUsername());
                event("join", r.getUsername());
            }
        });
        getEventRegistry().register(PlayerDisconnectEvent.class, (PlayerDisconnectEvent e) -> {
            PlayerRef r = e.getPlayerRef();
            if (r != null && r.getUuid() != null) {
                players.remove(r.getUuid().toString());
                event("quit", r.getUsername());
            }
        });

        post("/api/connector/register", baseJson(0));
        Thread hb = new Thread(this::heartbeatLoop, "conduit-hytale-heartbeat");
        hb.setDaemon(true);
        hb.start();
        System.out.println("[Conduit] Hytale connector enabled -> " + endpoint);
    }

    private void heartbeatLoop() {
        while (running) {
            try {
                post("/api/connector/heartbeat", baseJson(players.size()));
            } catch (Throwable ignored) {}
            try { Thread.sleep(3000); } catch (InterruptedException e) { break; }
        }
    }

    /** Build the register/heartbeat JSON body. */
    private String baseJson(int online) {
        StringBuilder sb = new StringBuilder();
        sb.append('{');
        kv(sb, "id", id).append(',');
        kv(sb, "task", task).append(',');
        kv(sb, "group", group).append(',');
        kv(sb, "env", "server").append(',');
        sb.append("\"online\":").append(online).append(',');
        sb.append("\"max\":").append(maxPlayers).append(',');
        sb.append("\"players\":[");
        boolean first = true;
        for (Map.Entry<String, String> e : players.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append('{');
            kv(sb, "uuid", e.getKey()).append(',');
            kv(sb, "name", e.getValue());
            sb.append('}');
        }
        sb.append("]}");
        return sb.toString();
    }

    private void event(String type, String player) {
        try {
            String body = "{" + q("type") + ":" + q(type) + "," + q("player") + ":" + q(player)
                    + "," + q("server") + ":" + q(task) + "}";
            post("/api/connector/event", body);
        } catch (Throwable ignored) {}
    }

    private void post(String path, String json) {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(endpoint + path))
                    .timeout(Duration.ofSeconds(6))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .build();
            http.send(req, HttpResponse.BodyHandlers.discarding());
        } catch (Throwable ignored) {}
    }

    private static StringBuilder kv(StringBuilder sb, String k, String v) {
        return sb.append(q(k)).append(':').append(q(v));
    }
    private static String q(String s) {
        if (s == null) return "\"\"";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(' ');
            else b.append(c);
        }
        return b.append('"').toString();
    }
    private static String envOr(String k, String d) {
        String v = System.getenv(k);
        return (v == null || v.isEmpty()) ? d : v;
    }
}
