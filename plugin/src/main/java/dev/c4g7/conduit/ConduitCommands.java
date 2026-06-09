package dev.c4g7.conduit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.Consumer;

/**
 * Platform-agnostic Conduit control command core — the CloudNet `/cloudnet` equivalent.
 * Runs network-wide by talking to the panel API, so it works from any server. Output is
 * emitted as legacy `&`-coded lines via the reply consumer; tab-completion is served by
 * {@link #complete}. Permission gating is done by the platform command wrapper.
 */
public final class ConduitCommands {
    // styled chrome
    private static final String BAR = "&8&m                                            ";
    private static final String TAG = "&b&lConduit";
    private static final List<String> SUBS = Arrays.asList(
            "list", "players", "send", "msg", "broadcast", "kick", "info", "help");

    private ConduitCommands() {}

    public static void run(ConduitClient client, String[] args, Consumer<String> reply) {
        String sub = args.length == 0 ? "help" : args[0].toLowerCase();
        switch (sub) {
            case "list", "servers" -> {
                JsonObject d = client.apiGet("/api/connector/servers");
                if (d == null) { err(reply, "panel unreachable"); return; }
                JsonArray servers = arr(d, "servers");
                header(reply, "Servers &8(&7" + servers.size() + "&8)");
                for (var el : servers) {
                    JsonObject s = el.getAsJsonObject();
                    String env = str(s, "env");
                    String dot = env.equals("proxy") ? "&d" : "&a";
                    int on = s.get("online").getAsInt(), max = s.get("max").getAsInt();
                    String tps = s.has("tps") && !s.get("tps").isJsonNull()
                            ? "  &8tps &7" + String.format("%.1f", s.get("tps").getAsDouble()) : "";
                    reply.accept("  " + dot + "● &f" + pad(str(s, "id").replace("network-", ""), 18)
                            + " &8" + pad(env, 7) + " &7" + on + "&8/&7" + max + tps);
                }
                footer(reply);
            }
            case "players", "who" -> {
                JsonObject d = client.apiGet("/api/connector/servers");
                if (d == null) { err(reply, "panel unreachable"); return; }
                JsonArray players = arr(d, "players");
                header(reply, "Players &8(&7" + players.size() + " online&8)");
                if (players.size() == 0) reply.accept("  &7No players online.");
                for (var el : players) {
                    JsonObject p = el.getAsJsonObject();
                    reply.accept("  &b▪ &f" + pad(str(p, "name"), 18) + " &8→ &7" + str(p, "server"));
                }
                footer(reply);
            }
            case "send", "move" -> {
                if (args.length < 3) { usage(reply, "send <player> <server>"); return; }
                ok(reply, client.queueAction("move", args[1], args[2], null, null),
                        "Moving &f" + args[1] + " &7→ &f" + args[2], "move failed");
            }
            case "msg", "message", "tell" -> {
                if (args.length < 3) { usage(reply, "msg <player> <text>"); return; }
                String text = join(args, 2);
                ok(reply, client.queueAction("message", args[1], null, text, null),
                        "Message sent to &f" + args[1], "message failed");
            }
            case "broadcast", "alert", "say" -> {
                if (args.length < 2) { usage(reply, "broadcast <text>"); return; }
                ok(reply, client.queueAction("broadcast", null, null, join(args, 1), null),
                        "Broadcast sent to the network", "broadcast failed");
            }
            case "kick" -> {
                if (args.length < 2) { usage(reply, "kick <player> [reason]"); return; }
                String reason = args.length > 2 ? join(args, 2) : null;
                ok(reply, client.queueAction("kick", args[1], null, null, reason),
                        "Kicked &f" + args[1], "kick failed");
            }
            case "info", "status" -> {
                JsonObject d = client.apiGet("/api/connector/servers");
                if (d == null) { err(reply, "panel unreachable"); return; }
                int servers = arr(d, "servers").size(), players = arr(d, "players").size();
                header(reply, "Network");
                reply.accept("  &7Servers&8: &f" + servers + "    &7Players&8: &f" + players);
                footer(reply);
            }
            default -> {
                header(reply, "Commands");
                cmd(reply, "list", "registered servers + counts");
                cmd(reply, "players", "everyone online, per server");
                cmd(reply, "send <player> <server>", "move a player");
                cmd(reply, "msg <player> <text>", "private message");
                cmd(reply, "broadcast <text>", "message everyone");
                cmd(reply, "kick <player> [reason]", "kick from the network");
                cmd(reply, "info", "network summary");
                footer(reply);
            }
        }
    }

    /**
     * Tab-completion suggestions. `players` / `servers` are the caller's locally-known names
     * (proxy can pass live lists; backends may pass empty). Filters by the current token.
     */
    public static List<String> complete(String[] args, List<String> players, List<String> servers) {
        if (args.length <= 1) return filter(SUBS, args.length == 1 ? args[0] : "");
        String sub = args[0].toLowerCase();
        String cur = args[args.length - 1];
        return switch (sub) {
            case "send", "move" -> args.length == 2 ? filter(players, cur)
                    : args.length == 3 ? filter(servers, cur) : List.of();
            case "msg", "message", "tell", "kick" -> args.length == 2 ? filter(players, cur) : List.of();
            default -> List.of();
        };
    }

    /* ---- formatting helpers ---- */
    private static void header(Consumer<String> r, String title) { r.accept(BAR); r.accept(" " + TAG + " &8» &f" + title); }
    private static void footer(Consumer<String> r) { r.accept(BAR); }
    private static void cmd(Consumer<String> r, String c, String desc) { r.accept("  &b/conduit " + c + " &8- &7" + desc); }
    private static void usage(Consumer<String> r, String u) { r.accept(" " + TAG + " &8» &cUsage&8: &7/conduit " + u); }
    private static void err(Consumer<String> r, String m) { r.accept(" " + TAG + " &8» &c" + m); }
    private static void ok(Consumer<String> r, boolean good, String okMsg, String badMsg) {
        r.accept(" " + TAG + " &8» " + (good ? "&a" + okMsg : "&c" + badMsg));
    }
    private static String pad(String s, int n) { return s.length() >= n ? s : s + " ".repeat(n - s.length()); }
    private static String join(String[] a, int from) { return String.join(" ", Arrays.copyOfRange(a, from, a.length)); }
    private static List<String> filter(List<String> opts, String cur) {
        String c = cur.toLowerCase();
        List<String> out = new ArrayList<>();
        for (String o : opts) if (o.toLowerCase().startsWith(c)) out.add(o);
        return out;
    }

    private static JsonArray arr(JsonObject o, String k) {
        return (o.has(k) && o.get(k).isJsonArray()) ? o.getAsJsonArray(k) : new JsonArray();
    }
    private static String str(JsonObject o, String k) {
        return (o.has(k) && !o.get(k).isJsonNull()) ? o.get(k).getAsString() : "";
    }
}
