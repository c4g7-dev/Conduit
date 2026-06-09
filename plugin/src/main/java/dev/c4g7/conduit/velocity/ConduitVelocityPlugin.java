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
import com.velocitypowered.api.event.player.KickedFromServerEvent;
import com.velocitypowered.api.event.player.PlayerChooseInitialServerEvent;
import com.velocitypowered.api.event.player.ServerConnectedEvent;
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
        for (ConduitClient.Action a : client.heartbeat(players.size(), max, null, players)) execute(a);
        updateTablist();
    }

    /* ---- config helpers (panel-driven) ---- */
    private JsonObject cfg() { return client == null ? null : client.config; }
    private String cfgStr(String k, String def) {
        JsonObject c = cfg();
        return (c != null && c.has(k) && !c.get(k).isJsonNull()) ? c.get(k).getAsString() : def;
    }
    private boolean maintenance() { JsonObject c = cfg(); return c != null && c.has("maintenance") && c.get("maintenance").getAsBoolean(); }
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

    /** Pick the least-loaded registered server whose name matches a fallback task (in priority order). */
    private Optional<RegisteredServer> pickFallback() {
        for (String task : fallbackTasks()) {
            RegisteredServer best = bestByPrefix(task);
            if (best != null) return Optional.of(best);
        }
        // last resort: any server
        return proxy.getAllServers().stream().findFirst();
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
        pickFallback().filter(rs -> !rs.equals(avoid)).ifPresent(rs -> p.createConnectionRequest(rs).fireAndForget());
    }

    /* ---- routing events ---- */
    @Subscribe
    public void onChooseInitial(PlayerChooseInitialServerEvent e) {
        pickFallback().ifPresent(e::setInitialServer);
    }

    @Subscribe
    public void onKicked(KickedFromServerEvent e) {
        Optional<RegisteredServer> fb = pickFallback();
        if (fb.isPresent() && (e.getServer() == null || !fb.get().equals(e.getServer()))) {
            e.setResult(KickedFromServerEvent.RedirectPlayer.create(fb.get()));
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

    @Subscribe
    public void onLogin(LoginEvent e) {
        if (maintenance() && !e.getPlayer().hasPermission("conduit.maintenance.bypass")) {
            e.setResult(com.velocitypowered.api.event.ResultedEvent.ComponentResult
                    .denied(Component.text("Network is in maintenance.", NamedTextColor.RED)));
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
            default -> {}
        }
    }

    @Subscribe
    public void onConnected(ServerConnectedEvent e) {
        client.event(e.getPreviousServer().isPresent() ? "switch" : "join",
                e.getPlayer().getUsername(), e.getServer().getServerInfo().getName());
    }

    @Subscribe
    public void onQuit(DisconnectEvent e) {
        client.event("quit", e.getPlayer().getUsername(), null);
    }
}
