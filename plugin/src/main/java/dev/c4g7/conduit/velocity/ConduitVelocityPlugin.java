package dev.c4g7.conduit.velocity;

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.event.player.ServerConnectedEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import net.kyori.adventure.text.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import dev.c4g7.conduit.ConduitClient;

/**
 * Conduit connector for Velocity — the proxy side of the CloudNet-Bridge equivalent.
 * Registers the proxy, heartbeats the full network player list, reports join/quit/switch,
 * and executes queued actions (move/message/broadcast/kick) returned by the heartbeat.
 */
@Plugin(id = "conduit-connector", name = "Conduit Connector", version = "1.0",
        description = "Conduit network connector", authors = {"c4g7"})
public class ConduitVelocityPlugin {
    private final ProxyServer proxy;
    private ConduitClient client;

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

        proxy.getScheduler().buildTask(this, this::tick)
                .repeat(3, TimeUnit.SECONDS).delay(2, TimeUnit.SECONDS).schedule();
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
        int max = proxy.getConfiguration().getShowMaxPlayers();
        for (ConduitClient.Action a : client.heartbeat(players.size(), max, null, players)) {
            execute(a);
        }
    }

    private void execute(ConduitClient.Action a) {
        switch (a.kind()) {
            case "move" -> proxy.getPlayer(a.player()).ifPresent(p ->
                    bestServer(a.target()).ifPresent(rs -> p.createConnectionRequest(rs).fireAndForget()));
            case "message" -> proxy.getPlayer(a.player()).ifPresent(p -> p.sendMessage(Component.text(a.text())));
            case "broadcast" -> proxy.getAllPlayers().forEach(p -> p.sendMessage(Component.text(a.text())));
            case "kick" -> proxy.getPlayer(a.player()).ifPresent(p ->
                    p.disconnect(Component.text(a.reason() == null ? "Kicked" : a.reason())));
            default -> {}
        }
    }

    /** Resolve an action target (task/server name) to a registered server, picking the
     *  least-loaded match by name prefix (e.g. "world" → world-202). */
    private Optional<RegisteredServer> bestServer(String name) {
        Optional<RegisteredServer> exact = proxy.getServer(name);
        if (exact.isPresent()) return exact;
        RegisteredServer best = null;
        for (RegisteredServer s : proxy.getAllServers()) {
            String n = s.getServerInfo().getName();
            if (n.equalsIgnoreCase(name) || n.toLowerCase().startsWith(name.toLowerCase())) {
                if (best == null || s.getPlayersConnected().size() < best.getPlayersConnected().size()) best = s;
            }
        }
        return Optional.ofNullable(best);
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
