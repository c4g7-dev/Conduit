package dev.c4g7.conduit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.Arrays;
import java.util.function.Consumer;

/**
 * Platform-agnostic `/ct` (Conduit) in-game control command — the CloudNet `/cloudnet`
 * equivalent. Runs network-wide by talking to the panel API, so it works from any server.
 * Replies are emitted as legacy `&`-coded lines via the supplied consumer (each platform
 * colorizes + sends). Permission gating is done by the platform command wrapper.
 */
public final class ConduitCommands {
    private static final String P = "&8[&bConduit&8] &7";

    private ConduitCommands() {}

    public static void run(ConduitClient client, String[] args, Consumer<String> reply) {
        String sub = args.length == 0 ? "help" : args[0].toLowerCase();
        switch (sub) {
            case "list", "servers" -> {
                JsonObject d = client.apiGet("/api/connector/servers");
                if (d == null) { reply.accept(P + "&cpanel unreachable"); return; }
                reply.accept(P + "&fServers:");
                for (var el : arr(d, "servers")) {
                    JsonObject s = el.getAsJsonObject();
                    reply.accept("  &b" + str(s, "id").replace("network-", "") + " &8(" + str(s, "env") + ") &7"
                            + s.get("online").getAsInt() + "&8/&7" + s.get("max").getAsInt()
                            + (s.has("tps") && !s.get("tps").isJsonNull() ? " &8tps=&7" + s.get("tps").getAsDouble() : ""));
                }
            }
            case "players", "list-players" -> {
                JsonObject d = client.apiGet("/api/connector/servers");
                if (d == null) { reply.accept(P + "&cpanel unreachable"); return; }
                JsonArray players = arr(d, "players");
                reply.accept(P + "&fPlayers online: &b" + players.size());
                for (var el : players) {
                    JsonObject p = el.getAsJsonObject();
                    reply.accept("  &b" + str(p, "name") + " &8→ &7" + str(p, "server"));
                }
            }
            case "send", "move" -> {
                if (args.length < 3) { reply.accept(P + "&cUsage: /ct send <player> <server>"); return; }
                boolean ok = client.queueAction("move", args[1], args[2], null, null);
                reply.accept(P + (ok ? "&aMoving &b" + args[1] + " &a→ &b" + args[2] : "&cfailed"));
            }
            case "msg", "message", "tell" -> {
                if (args.length < 3) { reply.accept(P + "&cUsage: /ct msg <player> <text>"); return; }
                String text = String.join(" ", Arrays.copyOfRange(args, 2, args.length));
                boolean ok = client.queueAction("message", args[1], null, text, null);
                reply.accept(P + (ok ? "&aMessaged &b" + args[1] : "&cfailed"));
            }
            case "broadcast", "alert", "say" -> {
                if (args.length < 2) { reply.accept(P + "&cUsage: /ct broadcast <text>"); return; }
                String text = String.join(" ", Arrays.copyOfRange(args, 1, args.length));
                boolean ok = client.queueAction("broadcast", null, null, text, null);
                reply.accept(P + (ok ? "&aBroadcast sent" : "&cfailed"));
            }
            case "kick" -> {
                if (args.length < 2) { reply.accept(P + "&cUsage: /ct kick <player> [reason]"); return; }
                String reason = args.length > 2 ? String.join(" ", Arrays.copyOfRange(args, 2, args.length)) : null;
                boolean ok = client.queueAction("kick", args[1], null, null, reason);
                reply.accept(P + (ok ? "&aKicked &b" + args[1] : "&cfailed"));
            }
            case "info", "status" -> {
                JsonObject d = client.apiGet("/api/connector/servers");
                if (d == null) { reply.accept(P + "&cpanel unreachable"); return; }
                int servers = arr(d, "servers").size(), players = arr(d, "players").size();
                reply.accept(P + "&fNetwork: &b" + servers + " &7servers, &b" + players + " &7players online");
            }
            default -> {
                reply.accept(P + "&fConduit commands:");
                reply.accept("  &b/ct list &8- servers   &b/ct players &8- online players");
                reply.accept("  &b/ct send <p> <server>  &8- move a player");
                reply.accept("  &b/ct msg <p> <text>   &b/ct kick <p> [reason]");
                reply.accept("  &b/ct broadcast <text>   &b/ct info");
            }
        }
    }

    private static JsonArray arr(JsonObject o, String k) {
        return (o.has(k) && o.get(k).isJsonArray()) ? o.getAsJsonArray(k) : new JsonArray();
    }
    private static String str(JsonObject o, String k) {
        return (o.has(k) && !o.get(k).isJsonNull()) ? o.get(k).getAsString() : "";
    }
}
