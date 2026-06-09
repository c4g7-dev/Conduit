package dev.c4g7.conduit.hytale;

import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.hypixel.hytale.server.core.plugin.JavaPluginInit;
import com.hypixel.hytale.server.core.event.events.player.PlayerConnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerDisconnectEvent;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.Message;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Conduit connector for Hytale — backend reporter AND action executor (parity with the Paper
 * connector). Tracks online players via PlayerConnect/Disconnect, POSTs register + heartbeat
 * (id/task/group + full name+uuid list) so Hytale players show in the network Players view, and
 * — since there's no Hytale proxy — executes the move/message/kick actions the panel queues for
 * its own players (move = referToServer to another Hytale instance, message = sendMessage,
 * kick = disconnect). JDK HttpClient forced HTTP/1.1 (Node panel mishandles HTTP/2). Gson is
 * bundled in HytaleServer.jar. Config via env, injected by Conduit at provision.
 */
public class ConduitHytalePlugin extends JavaPlugin {
    private static final Gson GSON = new Gson();
    private final Map<String, PlayerRef> players = new ConcurrentHashMap<>(); // uuid -> ref
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build();
    private volatile boolean running = true;
    private volatile long ackActionId = 0;
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
                players.put(r.getUuid().toString(), r);
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
                String resp = postForBody("/api/connector/heartbeat", baseJson(players.size()));
                if (resp != null) handleActions(resp);
            } catch (Throwable ignored) {}
            try { Thread.sleep(3000); } catch (InterruptedException e) { break; }
        }
    }

    /** Execute any queued actions targeting players on THIS server. */
    private void handleActions(String body) {
        try {
            JsonObject r = GSON.fromJson(body, JsonObject.class);
            if (r == null || !r.has("actions") || !r.get("actions").isJsonArray()) return;
            for (var el : r.getAsJsonArray("actions")) {
                JsonObject a = el.getAsJsonObject();
                long aid = a.has("id") ? a.get("id").getAsLong() : 0;
                if (aid <= ackActionId) continue;
                execute(a);
                if (aid > ackActionId) ackActionId = aid;
            }
        } catch (Throwable ignored) {}
    }

    private void execute(JsonObject a) {
        String kind = str(a, "kind");
        PlayerRef ref = byName(str(a, "player"));
        if (ref == null) return; // not our player — another executor (proxy/other Hytale) handles it
        try {
            switch (kind) {
                case "move" -> {
                    String target = str(a, "target");
                    // Hytale move targets are encoded "hyt:<host>:<port>"; ignore MC targets.
                    if (target != null && target.startsWith("hyt:")) {
                        String[] hp = target.substring(4).split(":");
                        if (hp.length == 2) ref.referToServer(hp[0], Integer.parseInt(hp[1]));
                    }
                }
                case "message" -> ref.sendMessage(Message.raw(strip(str(a, "text"))));
                case "broadcast" -> ref.sendMessage(Message.raw(strip(str(a, "text"))));
                case "kick" -> {
                    String reason = str(a, "reason");
                    ref.getPacketHandler().disconnect(Message.raw(reason == null || reason.isEmpty() ? "Kicked" : strip(reason)));
                }
                default -> {}
            }
        } catch (Throwable t) {
            System.out.println("[Conduit] action " + kind + " failed: " + t);
        }
    }

    private PlayerRef byName(String name) {
        if (name == null) return null;
        for (PlayerRef r : players.values()) if (name.equalsIgnoreCase(r.getUsername())) return r;
        return null;
    }

    /** Build the register/heartbeat JSON body (Gson). */
    private String baseJson(int online) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("task", task);
        o.addProperty("group", group);
        o.addProperty("env", "hytale");
        o.addProperty("online", online);
        o.addProperty("max", maxPlayers);
        o.addProperty("ackActionId", ackActionId);
        com.google.gson.JsonArray arr = new com.google.gson.JsonArray();
        for (Map.Entry<String, PlayerRef> e : players.entrySet()) {
            JsonObject p = new JsonObject();
            p.addProperty("uuid", e.getKey());
            p.addProperty("name", e.getValue().getUsername());
            arr.add(p);
        }
        o.add("players", arr);
        return GSON.toJson(o);
    }

    private void event(String type, String player) {
        try {
            JsonObject o = new JsonObject();
            o.addProperty("type", type);
            o.addProperty("player", player);
            o.addProperty("server", task);
            post("/api/connector/event", GSON.toJson(o));
        } catch (Throwable ignored) {}
    }

    private void post(String path, String json) {
        try { postForBody(path, json); } catch (Throwable ignored) {}
    }

    private String postForBody(String path, String json) {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(endpoint + path))
                    .timeout(Duration.ofSeconds(6))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .build();
            HttpResponse<String> r = http.send(req, HttpResponse.BodyHandlers.ofString());
            return r.statusCode() == 200 ? r.body() : null;
        } catch (Throwable t) { return null; }
    }

    /** Strip Minecraft &/§ colour codes (Hytale renders plain text). */
    private static String strip(String s) {
        return s == null ? "" : s.replaceAll("[&§][0-9A-Fa-fK-Ok-orR]", "");
    }
    private static String str(JsonObject o, String k) {
        return (o.has(k) && !o.get(k).isJsonNull()) ? o.get(k).getAsString() : null;
    }
    private static String envOr(String k, String d) {
        String v = System.getenv(k);
        return (v == null || v.isEmpty()) ? d : v;
    }
}
