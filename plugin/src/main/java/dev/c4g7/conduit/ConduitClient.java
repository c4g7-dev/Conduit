package dev.c4g7.conduit;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Shared transport between the Conduit connector plugin (Paper/Velocity) and the panel's
 * /api/connector endpoints. Sends register/heartbeat/event JSON over HTTP (JDK HttpClient +
 * Gson, both bundled by the platforms) and returns any actions the heartbeat hands back.
 *
 * Config (env or platform config): CONDUIT_ENDPOINT (e.g. http://10.27.27.50:3001),
 * CONDUIT_TOKEN, CONDUIT_SERVICE_ID, CONDUIT_TASK, CONDUIT_GROUP.
 */
public final class ConduitClient {
    private static final Gson GSON = new Gson();
    // Force HTTP/1.1 — the JDK client defaults to HTTP/2, which the Node panel server
    // mishandles ("header parser received no bytes").
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(5)).build();
    private final String endpoint, token, id, task, group, env;
    public volatile long ackActionId = 0;
    /** Latest proxy config pushed by the panel via the heartbeat response (routing/MOTD/tablist). */
    public volatile JsonObject config = null;

    public ConduitClient(String endpoint, String token, String id, String task, String group, String env) {
        this.endpoint = endpoint.replaceAll("/+$", "");
        this.token = token; this.id = id; this.task = task; this.group = group; this.env = env;
    }

    public static String envOr(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isEmpty()) ? def : v;
    }

    private HttpResponse<String> post(String path, JsonObject body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(endpoint + path))
                .timeout(Duration.ofSeconds(6))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(body)))
                .build();
        return http.send(req, HttpResponse.BodyHandlers.ofString());
    }

    public void register() {
        try {
            JsonObject o = base();
            HttpResponse<String> r = post("/api/connector/register", o);
            System.out.println("[Conduit] register " + endpoint + " -> " + r.statusCode());
        } catch (Throwable t) {
            System.out.println("[Conduit] register FAILED: " + t);
        }
    }

    /** A queued action the proxy must run, as returned by the heartbeat. */
    public record Action(long id, String kind, String player, String target, String text, String group, String reason) {}

    /**
     * Send a heartbeat with the current player list/counts. Returns actions to execute
     * (proxy only). players: list of [uuid, name] maps.
     */
    public List<Action> heartbeat(int online, int max, Double tps, List<Map<String, String>> players) {
        List<Action> out = new CopyOnWriteArrayList<>();
        try {
            JsonObject o = base();
            o.addProperty("online", online);
            o.addProperty("max", max);
            if (tps != null) o.addProperty("tps", tps);
            o.addProperty("ackActionId", ackActionId);
            JsonArray arr = new JsonArray();
            for (Map<String, String> p : players) {
                JsonObject pj = new JsonObject();
                pj.addProperty("uuid", p.getOrDefault("uuid", ""));
                pj.addProperty("name", p.getOrDefault("name", ""));
                if (p.containsKey("server")) pj.addProperty("server", p.get("server"));
                arr.add(pj);
            }
            o.add("players", arr);
            HttpResponse<String> resp = post("/api/connector/heartbeat", o);
            if (resp.statusCode() == 200) {
                JsonObject r = GSON.fromJson(resp.body(), JsonObject.class);
                if (r != null && r.has("config") && r.get("config").isJsonObject()) {
                    this.config = r.getAsJsonObject("config");
                }
                if (r != null && r.has("actions") && r.get("actions").isJsonArray()) {
                    for (var el : r.getAsJsonArray("actions")) {
                        JsonObject a = el.getAsJsonObject();
                        long aid = a.get("id").getAsLong();
                        out.add(new Action(aid,
                                str(a, "kind"), str(a, "player"), str(a, "target"),
                                str(a, "text"), str(a, "group"), str(a, "reason")));
                        if (aid > ackActionId) ackActionId = aid;
                    }
                }
            }
        } catch (Throwable t) {
            System.out.println("[Conduit] heartbeat FAILED: " + t);
        }
        return out;
    }

    public void event(String type, String player, String server) {
        try {
            JsonObject o = new JsonObject();
            o.addProperty("type", type);
            o.addProperty("player", player);
            if (server != null) o.addProperty("server", server);
            post("/api/connector/event", o);
        } catch (Exception ignored) {}
    }

    private JsonObject base() {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("task", task);
        o.addProperty("group", group);
        o.addProperty("env", env);
        return o;
    }

    private static String str(JsonObject o, String k) {
        return (o.has(k) && !o.get(k).isJsonNull()) ? o.get(k).getAsString() : null;
    }
}
