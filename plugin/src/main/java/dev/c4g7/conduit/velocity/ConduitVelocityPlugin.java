package dev.c4g7.conduit.velocity;

import com.google.gson.JsonObject;
import com.google.inject.Inject;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.tree.LiteralCommandNode;
import com.velocitypowered.api.command.BrigadierCommand;
import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.event.connection.LoginEvent;
import com.velocitypowered.api.event.connection.PreLoginEvent;
import com.velocitypowered.api.event.player.KickedFromServerEvent;
import com.velocitypowered.api.event.player.PlayerChooseInitialServerEvent;
import com.velocitypowered.api.event.player.ServerConnectedEvent;
import com.velocitypowered.api.event.player.ServerPreConnectEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyPingEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import com.velocitypowered.api.proxy.server.ServerPing;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import dev.c4g7.conduit.ConduitClient;
import dev.c4g7.conduit.ConduitCommands;

/**
 * Conduit connector for Velocity — proxy side of the CloudNet-Bridge/SyncProxy equivalent.
 * Registers the proxy, heartbeats the full network player list, reports join/quit/switch,
 * executes queued actions (move/message/broadcast/kick), and — driven by the panel-supplied
 * `config` — handles fallback routing (join + kick + /hub), MOTD, maintenance and tablist.
 */
@Plugin(id = "conduit-connector", name = "Conduit Connector", version = "1.0",
        description = "Conduit network connector", authors = {"c4g7"})
public class ConduitVelocityPlugin {
    private final ProxyServer proxy;
    private ConduitClient client;
    private static final LegacyComponentSerializer LEGACY = LegacyComponentSerializer.legacyAmpersand();

    @Inject
    public ConduitVelocityPlugin(ProxyServer proxy) { this.proxy = proxy; }

    @Subscribe
    public void onInit(ProxyInitializeEvent e) {
        String endpoint = ConduitClient.envOr("CONDUIT_ENDPOINT", "http://10.27.27.50:3001");
        String token = ConduitClient.envOr("CONDUIT_TOKEN", "");
        String id = ConduitClient.envOr("CONDUIT_SERVICE_ID", "proxy");
        String task = ConduitClient.envOr("CONDUIT_TASK", "proxy");
        String group = ConduitClient.envOr("CONDUIT_GROUP", "Network");
        client = new ConduitClient(endpoint, token, id, task, group, "proxy");
        client.register();

        // /hub /lobby /leave → send to the default fallback
        SimpleCommand hub = invocation -> {
            if (invocation.source() instanceof Player p) sendToFallback(p, null);
        };
        for (String name : new String[]{"hub", "lobby", "leave"}) {
            proxy.getCommandManager().register(proxy.getCommandManager().metaBuilder(name).build(), hub);
        }

        // /conduit /ct /cloud → network control. Explicit Brigadier nodes (greedy-string arg
        // with a real suggestion provider) — each alias registered independently so a name
        // collision can't strip the argument node (the "Incorrect argument for command" bug).
        for (String name : new String[]{"conduit", "ct", "cloud"}) {
            proxy.getCommandManager().register(new BrigadierCommand(buildBrigadier(name)));
        }

        // 1s tick: the proxy drains queued actions (incl. sharding moves) here, so a faster tick
        // means a player crossing a strip boundary is moved to the owning server within ~1s
        // instead of up to 3s (the lag felt during a handoff).
        proxy.getScheduler().buildTask(this, this::tick)
                .repeat(1, TimeUnit.SECONDS).delay(2, TimeUnit.SECONDS).schedule();
    }

    /** Split an argument line, keeping a trailing empty token so completion advances per arg. */
    private static String[] splitArgs(String raw) {
        if (raw == null || raw.isEmpty()) return new String[0];
        return raw.split(" ", -1);
    }

    /** Build a Brigadier command tree for one alias: `/name [greedy args]` with suggestions. */
    private LiteralCommandNode<CommandSource> buildBrigadier(String name) {
        return BrigadierCommand.literalArgumentBuilder(name)
                .requires(src -> src.hasPermission("conduit.admin"))
                .executes(ctx -> { runCmd(ctx.getSource(), new String[0]); return 1; })
                .then(BrigadierCommand.requiredArgumentBuilder("args", StringArgumentType.greedyString())
                        .suggests((ctx, builder) -> {
                            String remaining = builder.getRemaining();
                            String[] parts = remaining.isEmpty() ? new String[]{""} : remaining.split(" ", -1);
                            String token = parts[parts.length - 1];
                            List<String> players = proxy.getAllPlayers().stream().map(Player::getUsername).toList();
                            List<String> servers = proxy.getAllServers().stream().map(s -> s.getServerInfo().getName()).toList();
                            var off = builder.createOffset(builder.getStart() + remaining.length() - token.length());
                            for (String s : ConduitCommands.complete(parts, players, servers)) off.suggest(s);
                            return off.buildFuture();
                        })
                        .executes(ctx -> { runCmd(ctx.getSource(), splitArgs(StringArgumentType.getString(ctx, "args"))); return 1; }))
                .build();
    }

    private void runCmd(CommandSource src, String[] args) {
        ConduitCommands.run(client, args, line -> src.sendMessage(LEGACY.deserialize(line)));
    }

    private void tick() {
        List<Map<String, String>> players = new ArrayList<>();
        for (Player p : proxy.getAllPlayers()) {
            Map<String, String> m = new LinkedHashMap<>();
            m.put("uuid", p.getUniqueId().toString());
            m.put("name", p.getUsername());
            p.getCurrentServer().ifPresent(s -> m.put("server", s.getServerInfo().getName()));
            players.add(m);
        }
        int max = maxPlayers();
        client.queues = queueSnapshot();
        for (ConduitClient.Action a : client.heartbeat(players.size(), max, null, players)) execute(a);
        updateTablist();
        processQueues();
    }

    /** Queue state for the panel: [{id, players: [{uuid,name,priority}]}] in admit order. */
    private com.google.gson.JsonArray queueSnapshot() {
        com.google.gson.JsonArray out = new com.google.gson.JsonArray();
        for (var entry : queues.entrySet()) {
            var q = entry.getValue();
            synchronized (q) {
                if (q.isEmpty()) continue;
                java.util.List<java.util.UUID> order = new java.util.ArrayList<>(q.keySet());
                order.sort((a, b) -> Boolean.compare(!hasQueuePriority(a), !hasQueuePriority(b)));
                com.google.gson.JsonArray ps = new com.google.gson.JsonArray();
                for (java.util.UUID id : order) {
                    Player p = proxy.getPlayer(id).orElse(null);
                    if (p == null) continue;
                    JsonObject pj = new JsonObject();
                    pj.addProperty("uuid", id.toString());
                    pj.addProperty("name", p.getUsername());
                    if (hasQueuePriority(id)) pj.addProperty("priority", true);
                    ps.add(pj);
                }
                if (ps.size() == 0) continue;
                JsonObject qj = new JsonObject();
                qj.addProperty("id", entry.getKey());
                qj.add("players", ps);
                out.add(qj);
            }
        }
        return out;
    }

    /* ---- config helpers (panel-driven) ---- */
    private JsonObject cfg() { return client == null ? null : client.config; }
    private String cfgStr(String k, String def) {
        JsonObject c = cfg();
        return (c != null && c.has(k) && !c.get(k).isJsonNull()) ? c.get(k).getAsString() : def;
    }
    private boolean maintenance() { JsonObject c = cfg(); return c != null && c.has("maintenance") && c.get("maintenance").getAsBoolean(); }

    /* ---- per-task maintenance (task or its subgroup flagged in the panel) ---- */

    /** Lower-cased task names currently under maintenance, from the panel config. */
    private java.util.Set<String> maintenanceTasks() {
        java.util.Set<String> out = new java.util.HashSet<>();
        JsonObject c = cfg();
        if (c != null && c.has("maintenanceTasks") && c.get("maintenanceTasks").isJsonArray()) {
            for (var el : c.getAsJsonArray("maintenanceTasks")) out.add(el.getAsString().toLowerCase());
        }
        return out;
    }

    /** The task a registered server belongs to (server names are `<task>` or `<task>-N`). */
    private static String taskOf(String serverName) { return serverName.replaceAll("-\\d+$", "").toLowerCase(); }

    /** True when `serverName`'s task is in maintenance and this player has no bypass.
     *  Bypass: conduit.maintenance.bypass (everything) or conduit.maintenance.bypass.<task>. */
    private boolean closedFor(Player p, String serverName) {
        String task = taskOf(serverName);
        if (!maintenanceTasks().contains(task)) return false;
        return !p.hasPermission("conduit.maintenance.bypass")
                && !p.hasPermission("conduit.maintenance.bypass." + task);
    }

    /* ---- player caps (panel-enforced: network slotLimit + per-subgroup limits) ---- */

    /** The panel limit entry covering `serverName`'s task, or null. */
    private JsonObject limitFor(String serverName) {
        JsonObject c = cfg();
        if (c == null || !c.has("limits") || !c.get("limits").isJsonArray()) return null;
        String task = taskOf(serverName);
        for (var el : c.getAsJsonArray("limits")) {
            JsonObject lim = el.getAsJsonObject();
            for (var t : lim.getAsJsonArray("tasks")) {
                if (t.getAsString().equalsIgnoreCase(task)) return lim;
            }
        }
        return null;
    }

    /** Players currently online across a limit's member tasks. */
    private int limitOnline(JsonObject lim) {
        int online = 0;
        for (RegisteredServer s : proxy.getAllServers()) {
            String st = taskOf(s.getServerInfo().getName());
            for (var t : lim.getAsJsonArray("tasks")) {
                if (t.getAsString().equalsIgnoreCase(st)) { online += s.getPlayersConnected().size(); break; }
            }
        }
        return online;
    }

    /** Panel-resolved conduit.full.bypass holders (incl. LuckPerms group inheritance) —
     *  usable at PreLogin where permissions don't exist yet. */
    private boolean isBypassName(String username) {
        JsonObject c = cfg();
        if (c == null || !c.has("bypassNames") || !c.get("bypassNames").isJsonArray()) return false;
        for (var el : c.getAsJsonArray("bypassNames")) {
            if (el.getAsString().equalsIgnoreCase(username)) return true;
        }
        return false;
    }

    /* ---- subgroup queue: denied connects wait FIFO (VIP priority) for a free slot ---- */
    private final Map<String, java.util.LinkedHashMap<java.util.UUID, String>> queues = new java.util.concurrent.ConcurrentHashMap<>();

    private void enqueue(Player p, JsonObject lim, String targetServer) {
        var q = queues.computeIfAbsent(lim.get("id").getAsString(), k -> new java.util.LinkedHashMap<>());
        synchronized (q) {
            boolean fresh = q.putIfAbsent(p.getUniqueId(), targetServer) == null;
            int pos = 1;
            for (var u : q.keySet()) { if (u.equals(p.getUniqueId())) break; pos++; }
            p.sendMessage(LEGACY.deserialize(lim.get("message").getAsString()
                    + (fresh ? " &7Queued — position &f" + pos + "&7." : " &7Still queued — position &f" + pos + "&7.")));
        }
    }

    /** Each tick: admit queued players into limits with free capacity — VIP
     *  (conduit.queue.priority) first, then FIFO (stable sort keeps arrival order). */
    private void processQueues() {
        JsonObject c = cfg();
        if (c == null || !c.has("limits") || !c.get("limits").isJsonArray()) return;
        for (var el : c.getAsJsonArray("limits")) {
            JsonObject lim = el.getAsJsonObject();
            var q = queues.get(lim.get("id").getAsString());
            if (q == null || q.isEmpty()) continue;
            int free = lim.get("limit").getAsInt() - limitOnline(lim);
            if (free <= 0) continue;
            synchronized (q) {
                java.util.List<java.util.UUID> order = new java.util.ArrayList<>(q.keySet());
                order.sort((a, b) -> Boolean.compare(!hasQueuePriority(a), !hasQueuePriority(b)));
                for (java.util.UUID id : order) {
                    if (free <= 0) break;
                    Player p = proxy.getPlayer(id).orElse(null);
                    if (p == null) { q.remove(id); continue; }
                    String target = q.remove(id);
                    RegisteredServer rs = bestByPrefix(taskOf(target));
                    if (rs != null) {
                        p.sendMessage(LEGACY.deserialize("&8[&bConduit&8] &aA slot opened — connecting…"));
                        p.createConnectionRequest(rs).fireAndForget();
                        free--;
                    }
                }
            }
        }
    }

    private boolean hasQueuePriority(java.util.UUID id) {
        return proxy.getPlayer(id).map(p -> p.hasPermission("conduit.queue.priority")).orElse(false);
    }

    private void dropFromQueues(java.util.UUID id) {
        for (var q : queues.values()) { synchronized (q) { q.remove(id); } }
    }
    private int maxPlayers() { JsonObject c = cfg(); return (c != null && c.has("maxPlayers")) ? c.get("maxPlayers").getAsInt() : proxy.getConfiguration().getShowMaxPlayers(); }

    /** Ordered fallback task-name prefixes from config (default first). */
    private List<String> fallbackTasks() {
        List<String> out = new ArrayList<>();
        JsonObject c = cfg();
        if (c != null && c.has("fallbacks") && c.get("fallbacks").isJsonArray()) {
            for (var el : c.getAsJsonArray("fallbacks")) out.add(el.getAsJsonObject().get("task").getAsString());
        }
        return out;
    }

    /** Pick the least-loaded registered server whose name matches a fallback task (in priority
     *  order), skipping tasks closed for this player by maintenance. `p` may be null (no player
     *  context → maintenance not filtered). */
    private Optional<RegisteredServer> pickFallback(Player p) {
        for (String task : fallbackTasks()) {
            if (p != null && closedFor(p, task)) continue;
            RegisteredServer best = bestByPrefix(task);
            if (best != null) return Optional.of(best);
        }
        // last resort: any server the player may enter
        return proxy.getAllServers().stream()
                .filter(s -> p == null || !closedFor(p, s.getServerInfo().getName()))
                .findFirst();
    }

    private RegisteredServer bestByPrefix(String prefix) {
        RegisteredServer best = null;
        for (RegisteredServer s : proxy.getAllServers()) {
            String n = s.getServerInfo().getName();
            if (n.equalsIgnoreCase(prefix) || n.toLowerCase().startsWith(prefix.toLowerCase() + "-") || n.toLowerCase().startsWith(prefix.toLowerCase())) {
                if (best == null || s.getPlayersConnected().size() < best.getPlayersConnected().size()) best = s;
            }
        }
        return best;
    }

    private void sendToFallback(Player p, RegisteredServer avoid) {
        pickFallback(p).filter(rs -> !rs.equals(avoid)).ifPresent(rs -> p.createConnectionRequest(rs).fireAndForget());
    }

    /* ---- routing events ---- */
    @Subscribe
    public void onChooseInitial(PlayerChooseInitialServerEvent e) {
        pickFallback(e.getPlayer()).ifPresent(e::setInitialServer);
    }

    @Subscribe
    public void onKicked(KickedFromServerEvent e) {
        Optional<RegisteredServer> fb = pickFallback(e.getPlayer());
        if (fb.isPresent() && (e.getServer() == null || !fb.get().equals(e.getServer()))) {
            e.setResult(KickedFromServerEvent.RedirectPlayer.create(fb.get()));
        }
    }

    /** Per-task maintenance gate: deny connecting to a closed task's servers (panel toggle on the
     *  task or its subgroup), with a styled notice. Fallback picking already avoids closed tasks,
     *  so this catches explicit connects (/server, signs, plugins, panel moves). */
    @Subscribe
    public void onServerPreConnect(ServerPreConnectEvent e) {
        RegisteredServer target = e.getResult().getServer().orElse(null);
        if (target == null) return;
        String name = target.getServerInfo().getName();
        if (closedFor(e.getPlayer(), name)) {
            e.setResult(ServerPreConnectEvent.ServerResult.denied());
            e.getPlayer().sendMessage(LEGACY.deserialize(
                    "&8[&bConduit&8] &7" + taskOf(name) + " &cis in maintenance."));
            return;
        }
        // Per-subgroup player cap (panel subgroup.slotLimit): a full slice doesn't hard-reject —
        // the player is QUEUED (FIFO, conduit.queue.priority skips ahead) and auto-connected
        // when a slot frees. Already-queued players get their position re-announced.
        JsonObject lim = limitFor(name);
        if (lim != null && !e.getPlayer().hasPermission("conduit.full.bypass")
                && limitOnline(lim) >= lim.get("limit").getAsInt()) {
            e.setResult(ServerPreConnectEvent.ServerResult.denied());
            enqueue(e.getPlayer(), lim, name);
        }
    }

    /* ---- MOTD + maintenance ---- */
    @Subscribe
    public void onPing(ProxyPingEvent e) {
        String l1 = cfgStr("motdLine1", "");
        String l2 = cfgStr("motdLine2", "");
        ServerPing.Builder b = e.getPing().asBuilder();
        if (!l1.isEmpty() || !l2.isEmpty()) {
            b.description(LEGACY.deserialize(l1 + (l2.isEmpty() ? "" : "\n" + l2)));
        }
        ServerPing.Players pl = e.getPing().getPlayers().orElse(null);
        int online = proxy.getPlayerCount();
        b.onlinePlayers(online).maximumPlayers(maxPlayers());
        e.setPing(b.build());
    }

    /** Network-full deny at PreLogin — BEFORE Mojang session auth and encryption, so a join
     *  storm against a full network costs essentially nothing (no auth round-trip, no crypto,
     *  no LuckPerms load). Bypass holders are matched by name from the panel-resolved list. */
    @Subscribe
    public void onPreLogin(PreLoginEvent e) {
        int max = maxPlayers();
        if (max <= 0 || proxy.getPlayerCount() < max) return;
        if (isBypassName(e.getUsername())) return;
        e.setResult(PreLoginEvent.PreLoginComponentResult.denied(
                LEGACY.deserialize(cfgStr("fullMessage", "&cThe network is full."))));
    }

    @Subscribe
    public void onLogin(LoginEvent e) {
        if (maintenance() && !e.getPlayer().hasPermission("conduit.maintenance.bypass")) {
            e.setResult(com.velocitypowered.api.event.ResultedEvent.ComponentResult
                    .denied(Component.text("Network is in maintenance.", NamedTextColor.RED)));
            return;
        }
        // Permission-accurate backstop for the PreLogin deny (covers a bypass granted seconds
        // ago that the ~30s panel name-list hasn't picked up, or stale list edge cases).
        int max = maxPlayers();
        if (max > 0 && proxy.getPlayerCount() >= max && !e.getPlayer().hasPermission("conduit.full.bypass")) {
            e.setResult(com.velocitypowered.api.event.ResultedEvent.ComponentResult
                    .denied(LEGACY.deserialize(cfgStr("fullMessage", "&cThe network is full."))));
        }
    }

    /* ---- tablist ---- */
    private void updateTablist() {
        String h = cfgStr("tablistHeader", null);
        String f = cfgStr("tablistFooter", null);
        if (h == null && f == null) return;
        for (Player p : proxy.getAllPlayers()) {
            String server = p.getCurrentServer().map(s -> s.getServerInfo().getName()).orElse("-");
            String task = server.replaceAll("-\\d+$", "");
            long ping = p.getPing();
            Component header = LEGACY.deserialize(fill(h == null ? "" : h, server, task, ping));
            Component footer = LEGACY.deserialize(fill(f == null ? "" : f, server, task, ping));
            p.sendPlayerListHeaderAndFooter(header, footer);
        }
    }

    private String fill(String s, String server, String task, long ping) {
        return s.replace("%proxy%", proxy.getBoundAddress().getHostString())
                .replace("%server%", server).replace("%task%", task)
                .replace("%online%", String.valueOf(proxy.getPlayerCount()))
                .replace("%max%", String.valueOf(maxPlayers()))
                .replace("%ping%", String.valueOf(ping));
    }

    /* ---- queued actions ---- */
    private void execute(ConduitClient.Action a) {
        // Hytale-scoped actions are handled by the Hytale connector, not the proxy — skip them so
        // a kick/message/move for a Hytale player doesn't also hit a same-named MC player here.
        if ("hytale".equals(a.env())) return;
        switch (a.kind()) {
            case "move" -> proxy.getPlayer(a.player()).ifPresent(p ->
                    Optional.ofNullable(bestByPrefix(a.target())).ifPresent(rs -> p.createConnectionRequest(rs).fireAndForget()));
            case "message" -> proxy.getPlayer(a.player()).ifPresent(p -> p.sendMessage(LEGACY.deserialize(a.text())));
            case "broadcast" -> proxy.getAllPlayers().forEach(p -> p.sendMessage(LEGACY.deserialize(a.text())));
            case "kick" -> proxy.getPlayer(a.player()).ifPresent(p ->
                    p.disconnect(LEGACY.deserialize(a.reason() == null ? "Kicked" : a.reason())));
            case "unqueue" -> proxy.getPlayer(a.player()).ifPresent(p -> {
                dropFromQueues(p.getUniqueId());
                p.sendMessage(LEGACY.deserialize("&8[&bConduit&8] &7You were removed from the queue."));
            });
            default -> {}
        }
    }

    @Subscribe
    public void onConnected(ServerConnectedEvent e) {
        // A successful connect anywhere abandons any pending queue spots (the player moved on).
        dropFromQueues(e.getPlayer().getUniqueId());
        client.event(e.getPreviousServer().isPresent() ? "switch" : "join",
                e.getPlayer().getUsername(), e.getServer().getServerInfo().getName());
    }

    @Subscribe
    public void onQuit(DisconnectEvent e) {
        dropFromQueues(e.getPlayer().getUniqueId());
        client.event("quit", e.getPlayer().getUsername(), null);
    }
}
