package dev.c4g7.conduit.paper;

import com.google.gson.JsonObject;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import dev.c4g7.conduit.ConduitClient;

/**
 * Cross-service shared inventory (ideas.md §sharding follow-up). When this service belongs to a
 * panel-defined inventory-share group, a player's full state (inventory, ender chest, HP/XP,
 * effects, gamemode) is stashed to Redis on quit and restored on join — so switching between
 * INDEPENDENT services in the same group carries the player's inventory, not just instances of
 * one sharded world.
 *
 * Keyed by group + uuid: `conduit:inv:<group>:<uuid>`. Write-on-quit / read+delete-on-join is the
 * standard cross-server-inventory handoff. Disabled when the service is sharded (ConduitSharding
 * already syncs its own instances via PD_KEY) to avoid double-capture.
 */
final class ConduitInvShare {
    private static final String KEY = "conduit:inv:"; // + group + ":" + uuid
    private final Plugin plugin;
    private final ConduitClient client;
    private final RedisClient redis = new RedisClient(List.of(), "");
    private volatile String group = null; // active share-group id, or null

    ConduitInvShare(Plugin plugin, ConduitClient client) {
        this.plugin = plugin;
        this.client = client;
    }

    /** Refresh from the heartbeat config (called alongside the sharding update). `shardingActive`
     *  suppresses inv-share so a sharded service doesn't double-capture. */
    void update(boolean shardingActive) {
        JsonObject cfg = client.config;
        String g = (cfg != null && cfg.has("invGroup") && !cfg.get("invGroup").isJsonNull())
                ? cfg.get("invGroup").getAsString() : null;
        if (shardingActive) g = null;
        this.group = g;
        if (g == null) { redis.configure(List.of(), ""); return; }
        // redis endpoints arrive either in the sharding block or top-level (non-sharded service)
        JsonObject rc = null;
        if (cfg.has("redis") && cfg.get("redis").isJsonObject()) rc = cfg.getAsJsonObject("redis");
        else if (cfg.has("sharding") && cfg.get("sharding").isJsonObject()
                && cfg.getAsJsonObject("sharding").has("redis")) rc = cfg.getAsJsonObject("sharding").getAsJsonObject("redis");
        if (rc != null && rc.has("endpoints")) {
            List<String> eps = new ArrayList<>();
            for (var el : rc.getAsJsonArray("endpoints")) eps.add(el.getAsString());
            redis.configure(eps, rc.has("password") ? rc.get("password").getAsString() : "");
        } else {
            redis.configure(List.of(), "");
        }
    }

    boolean active() { return group != null && redis.available(); }

    /** Stash the player's state on quit (async — off the main thread). */
    void onQuit(Player p) {
        if (!active()) return;
        final String uuid = p.getUniqueId().toString();
        final String pd = PlayerState.capture(p);
        plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> {
            try { redis.setex(KEY + group + ":" + uuid, 300, pd); } catch (Throwable ignored) {}
        });
    }

    /** Restore the player's state on join if a stashed snapshot exists (then consume it). */
    void onJoin(Player p) {
        if (!active()) return;
        final UUID id = p.getUniqueId();
        final String key = KEY + group + ":" + id;
        plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> {
            String pd;
            try { pd = redis.get(key); } catch (Throwable t) { return; }
            if (pd == null || pd.isEmpty()) return;
            final com.google.gson.JsonObject o;
            try { o = com.google.gson.JsonParser.parseString(pd).getAsJsonObject(); } catch (Throwable t) { return; }
            plugin.getServer().getScheduler().runTask(plugin, () -> {
                Player pl = plugin.getServer().getPlayer(id);
                if (pl != null && pl.isOnline()) { PlayerState.apply(pl, o); redis.del(key); }
            });
        });
    }
}
