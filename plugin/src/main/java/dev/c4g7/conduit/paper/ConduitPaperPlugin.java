package dev.c4g7.conduit.paper;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.plugin.java.JavaPlugin;

import com.google.gson.JsonObject;

import dev.c4g7.conduit.ConduitCommands;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import dev.c4g7.conduit.ConduitClient;

/**
 * Conduit connector for Paper — the backend side. Registers the server, heartbeats its
 * player list (name+UUID), count, and TPS, and reports join/quit. Actions are proxy-only,
 * so backends just report.
 */
public class ConduitPaperPlugin extends JavaPlugin implements Listener {
    private ConduitClient client;
    private String selfTask;
    private ConduitSharding sharding;

    @Override
    public void onEnable() {
        String endpoint = ConduitClient.envOr("CONDUIT_ENDPOINT", "http://10.27.27.50:3001");
        String token = ConduitClient.envOr("CONDUIT_TOKEN", "");
        String id = ConduitClient.envOr("CONDUIT_SERVICE_ID", Bukkit.getServer().getName());
        selfTask = ConduitClient.envOr("CONDUIT_TASK", "server");
        String group = ConduitClient.envOr("CONDUIT_GROUP", "Network");
        client = new ConduitClient(endpoint, token, id, selfTask, group, "server");
        sharding = new ConduitSharding(this, client);
        client.register();

        getServer().getPluginManager().registerEvents(this, this);
        // heartbeat every 3s on the main scheduler
        getServer().getScheduler().runTaskTimer(this, this::tick, 40L, 60L);
        // sharding: apply config + drive the boundary handoff on the main thread every 10 ticks
        getServer().getScheduler().runTaskTimer(this, this::shardTick, 100L, 10L);
    }

    @Override
    public void onDisable() {
        // drop out of the panel's live set immediately → "restarting…" shows within a second
        if (client != null) client.unregister();
    }

    /** Main-thread sharding loop: refresh grid from the panel config, then tick each player. */
    private void shardTick() {
        JsonObject cfg = client.config;
        JsonObject sh = (cfg != null && cfg.has("sharding") && cfg.get("sharding").isJsonObject())
                ? cfg.getAsJsonObject("sharding") : null;
        sharding.update(sh);
        if (sharding.active()) for (Player p : Bukkit.getOnlinePlayers()) sharding.tickPlayer(p);
    }

    private void tick() {
        List<Map<String, String>> players = new ArrayList<>();
        for (Player p : Bukkit.getOnlinePlayers()) {
            Map<String, String> m = new LinkedHashMap<>();
            m.put("uuid", p.getUniqueId().toString());
            m.put("name", p.getName());
            players.add(m);
        }
        double tps = 20.0;
        try { double[] t = Bukkit.getTPS(); if (t.length > 0) tps = Math.min(20.0, t[0]); } catch (Throwable ignored) {}
        int max = Bukkit.getMaxPlayers();
        // backends don't receive actions; run on an async thread to avoid blocking the tick
        final double ftps = tps;
        getServer().getScheduler().runTaskAsynchronously(this, () ->
                client.heartbeat(players.size(), max, ftps, players));
    }

    @Override
    public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (!sender.hasPermission("conduit.admin")) { sender.sendMessage(ChatColor.RED + "No permission."); return true; }
        // Run the command core async (it does HTTP); reply on the main thread via the scheduler.
        getServer().getScheduler().runTaskAsynchronously(this, () ->
                ConduitCommands.run(client, args, line ->
                        getServer().getScheduler().runTask(this, () ->
                                sender.sendMessage(ChatColor.translateAlternateColorCodes('&', line)))));
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command cmd, String alias, String[] args) {
        if (!sender.hasPermission("conduit.admin")) return List.of();
        // Runs on the main thread — keep it non-blocking: subcommands + a cached server/player
        // snapshot refreshed by the heartbeat (no HTTP here). Local players always available.
        List<String> players = new ArrayList<>(Bukkit.getOnlinePlayers().stream().map(Player::getName).toList());
        for (String n : client.cachedPlayers()) if (!players.contains(n)) players.add(n);
        return ConduitCommands.complete(args, players, client.cachedServers());
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        sharding.onJoin(e.getPlayer());
        getServer().getScheduler().runTaskAsynchronously(this, () ->
                client.event("join", e.getPlayer().getName(), selfTask));
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        sharding.onQuit(e.getPlayer());
        getServer().getScheduler().runTaskAsynchronously(this, () ->
                client.event("quit", e.getPlayer().getName(), selfTask));
    }

    // Seam no-build buffer: block edits near a strip boundary (the neighbour region owns them).
    @EventHandler
    public void onPlace(BlockPlaceEvent e) {
        if (!sharding.mayInteract(e.getBlock().getLocation())) e.setCancelled(true);
    }

    @EventHandler
    public void onBreak(BlockBreakEvent e) {
        if (!sharding.mayInteract(e.getBlock().getLocation())) e.setCancelled(true);
    }
}
