package dev.c4g7.conduit.paper;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.WorldBorder;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

import net.md_5.bungee.api.ChatMessageType;
import net.md_5.bungee.api.chat.TextComponent;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import dev.c4g7.conduit.ConduitClient;

/**
 * Seamless world-sharding for the Paper backend — the Conduit-native equivalent of SKYDINSE's
 * TMregion serverlogic. The panel pushes this instance its strip grid via the heartbeat config
 * (config.sharding {self, grid, pending}); we:
 *   - set the vanilla world border to the FULL combined world (so players see one continuous
 *     world, every region identical),
 *   - every 10 ticks find which region owns each player's X; if it isn't us, report the cross to
 *     the panel with the player's exact coords (which queues a proxy move + stashes the coords)
 *     and shove the player back from the seam until they're connected,
 *   - warn players approaching a boundary and block building inside the seam buffer,
 *   - on join (or as soon as coords arrive) teleport handed-off players to their stored position.
 * Same seed on every region ⇒ identical terrain ⇒ the crossing is seamless.
 *
 * (Player inventory/HP/XP sync across the handoff is a follow-up — needs a shared store, e.g.
 * Redis; this delivers the seamless *world* + position. Until then each region keeps its own
 * player data, like separate servers.)
 */
final class ConduitSharding {
    private static final Gson GSON = new Gson();
    private static final String PD_KEY = "conduit:pd:"; // + uuid
    private final JavaPlugin plugin;
    private final ConduitClient client;
    private final RedisClient redis = new RedisClient(List.of(), "");

    private record Strip(double min, double max) {}
    private record Region(String serverId, String target, String name, Map<String, Strip> worlds) {}

    private volatile String self = "";
    private volatile List<Region> regions = List.of();
    private volatile Map<String, Double> borderDiameter = Map.of(); // world -> diameter
    private volatile double centerX = 0, centerZ = 0;
    private volatile double cancelRange = 30;
    private volatile String gridSig = "";

    // per-player runtime state (keyed by lowercase name)
    private final Map<String, Long> joinAt = new ConcurrentHashMap<>();
    private final Map<String, Long> transferring = new ConcurrentHashMap<>();
    private final Map<String, String> applied = new ConcurrentHashMap<>(); // name -> loc already restored

    ConduitSharding(JavaPlugin plugin, ConduitClient client) {
        this.plugin = plugin;
        this.client = client;
    }

    boolean active() { return !regions.isEmpty(); }

    void onJoin(Player p) {
        joinAt.put(p.getName().toLowerCase(), System.currentTimeMillis());
        // snappy restore: fetch our pending coords now rather than waiting for a heartbeat.
        plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> {
            JsonObject r = client.apiGet("/api/connector/pending?id=" + url(self));
            if (r == null || !r.has("pending")) return;
            for (var el : r.getAsJsonArray("pending")) {
                JsonObject e = el.getAsJsonObject();
                if (e.get("player").getAsString().equalsIgnoreCase(p.getName()))
                    restore(p, e.get("loc").getAsString());
            }
        });
    }

    void onQuit(Player p) {
        String k = p.getName().toLowerCase();
        joinAt.remove(k); transferring.remove(k); applied.remove(k);
    }

    /** True unless the location sits inside our strip's seam buffer (block edits blocked there). */
    boolean mayInteract(Location loc) {
        if (regions.isEmpty()) return true;
        Region me = selfRegion();
        if (me == null) return true;
        Strip s = me.worlds().get(loc.getWorld().getName());
        if (s == null) return true;
        double x = loc.getX();
        if (x < s.min() || x > s.max()) return true; // not our strip (shouldn't build anyway)
        return Math.min(x - s.min(), s.max() - x) >= cancelRange;
    }

    /** Parse the panel's config.sharding block (called from the heartbeat tick). */
    void update(JsonObject sharding) {
        if (sharding == null) { if (!regions.isEmpty()) clear(); return; }
        try {
            self = str(sharding, "self");
            JsonObject grid = sharding.getAsJsonObject("grid");
            String sig = grid.toString();
            if (!sig.equals(gridSig)) {
                gridSig = sig;
                parseGrid(grid);
                plugin.getServer().getScheduler().runTask(plugin, this::applyBorders);
            }
            // Redis endpoints for player-data sync (primary first; connector fails over the list).
            if (sharding.has("redis") && sharding.get("redis").isJsonObject()) {
                JsonObject rc = sharding.getAsJsonObject("redis");
                List<String> eps = new ArrayList<>();
                if (rc.has("endpoints")) for (var el : rc.getAsJsonArray("endpoints")) eps.add(el.getAsString());
                redis.configure(eps, rc.has("password") ? rc.get("password").getAsString() : "");
            } else {
                redis.configure(List.of(), "");
            }
            if (sharding.has("pending") && sharding.get("pending").isJsonArray())
                applyPending(sharding.getAsJsonArray("pending"));
        } catch (Throwable t) {
            System.out.println("[Conduit] sharding config parse failed: " + t);
        }
    }

    private void parseGrid(JsonObject grid) {
        List<Region> rs = new ArrayList<>();
        for (var el : grid.getAsJsonArray("regions")) {
            JsonObject r = el.getAsJsonObject();
            Map<String, Strip> worlds = new ConcurrentHashMap<>();
            JsonObject w = r.getAsJsonObject("worlds");
            for (String k : w.keySet()) {
                JsonObject st = w.getAsJsonObject(k);
                worlds.put(k, new Strip(st.get("min").getAsDouble(), st.get("max").getAsDouble()));
            }
            rs.add(new Region(str(r, "serverId"), str(r, "target"), str(r, "name"), worlds));
        }
        regions = rs;
        JsonObject c = grid.getAsJsonObject("center");
        centerX = c.get("x").getAsDouble();
        centerZ = c.get("z").getAsDouble();
        cancelRange = grid.has("cancelRange") ? grid.get("cancelRange").getAsDouble() : 30;
        Map<String, Double> bd = new ConcurrentHashMap<>();
        JsonObject b = grid.getAsJsonObject("border");
        for (String k : b.keySet()) bd.put(k, b.get(k).getAsDouble());
        borderDiameter = bd;
    }

    private void clear() {
        regions = List.of(); borderDiameter = Map.of(); gridSig = "";
    }

    /** Set each world's vanilla border to the full combined width centered on the cluster. */
    private void applyBorders() {
        for (Map.Entry<String, Double> e : borderDiameter.entrySet()) {
            World world = Bukkit.getWorld(e.getKey());
            if (world == null) continue;
            // overworld/end border centre is centerX*8; nether is centerX (MC 1:8 scale).
            double cx = e.getKey().equals("world_nether") ? centerX : centerX * 8;
            WorldBorder wb = world.getWorldBorder();
            wb.setCenter(cx, centerZ);
            wb.setSize(e.getValue());
        }
    }

    private Region selfRegion() {
        for (Region r : regions) if (r.serverId().equals(self)) return r;
        return null;
    }

    private Region owning(String world, double x) {
        for (Region r : regions) {
            Strip s = r.worlds().get(world);
            if (s != null && x >= s.min() && x <= s.max()) return r;
        }
        return null;
    }

    /** Per-player tick (every 10 ticks, main thread): handoff + edge warning + push-back. */
    void tickPlayer(Player p) {
        if (regions.isEmpty()) return;
        Location loc = p.getLocation();
        String world = loc.getWorld().getName();
        double x = loc.getX();
        String key = p.getName().toLowerCase();
        long now = System.currentTimeMillis();

        Region own = owning(world, x);
        warnNearBorder(p, world, x);

        if (own != null && !own.serverId().equals(self)) {
            // just-joined grace: avoid bouncing a player teleported in near the seam.
            Long jt = joinAt.get(key);
            if (jt != null && now - jt < 2000) return;
            Long tt = transferring.get(key);
            if (tt == null) {
                transferring.put(key, now);
                String locStr = x + ";" + loc.getY() + ";" + loc.getZ() + ";" + world + ";" + loc.getYaw() + ";" + loc.getPitch();
                final Region target = own;
                // Capture full player state on the main thread, then async: stash it in Redis
                // (keyed by uuid, short TTL) + report the cross to the panel (queues the move).
                final String pd = redis.available() ? PlayerState.capture(p) : null;
                final UUID uuid = p.getUniqueId();
                plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> {
                    if (pd != null) redis.setex(PD_KEY + uuid, 60, pd);
                    client.transfer(p.getName(), target.target(), target.serverId(), locStr);
                });
            } else if (now - tt > 1500) {
                transferring.remove(key); // re-post if the move stalled
            }
            // No push while crossing — the player walks through cleanly into the neighbour's
            // strip and is teleported at their exact position when the move lands. Only a HARD
            // cap kicks in if the move is lagging and they've run too far past the seam.
            hardCap(p, world, x);
        }
    }

    private void warnNearBorder(Player p, String world, double x) {
        Region me = selfRegion();
        if (me == null) return;
        Strip s = me.worlds().get(world);
        if (s == null) return;
        double d = Math.min(x - s.min(), s.max() - x);
        if (d > 150 || d < 0) return;
        // graduated proximity colour: 150..100 green, 100..30 yellow, <30 red
        String color = d > 100 ? "§a" : d >= 30 ? "§e" : "§c";
        String msg = color + "Region border " + Math.round(d) + "m";
        p.spigot().sendMessage(ChatMessageType.ACTION_BAR, TextComponent.fromLegacyText(msg));
    }

    /**
     * No-op until a player has run more than HARD_CAP blocks past their own strip boundary with
     * the transfer still pending (i.e. the move is lagging). Up to that point they walk through
     * the seam cleanly and get teleported at their exact position when the move lands — a smooth
     * walk-through. Beyond the cap, snap them back to CAP_BACK blocks past the seam so they can't
     * run indefinitely into a neighbour's terrain if the move is stuck.
     */
    private static final double HARD_CAP = 25;
    private static final double CAP_BACK = 10;
    private void hardCap(Player p, String world, double x) {
        Region me = selfRegion();
        if (me == null) return;
        Strip s = me.worlds().get(world);
        if (s == null) return;
        double over = x < s.min() ? s.min() - x : (x > s.max() ? x - s.max() : 0);
        if (over <= HARD_CAP) return; // walk freely up to the cap — no push
        double edge = x < s.min() ? s.min() : s.max();
        double dir = x < s.min() ? -1 : 1; // sign of how far past (west = below min)
        Location l = p.getLocation();
        l.setX(edge + dir * CAP_BACK); // CAP_BACK blocks past the seam, no further
        p.teleport(safeY(l));
    }

    private void applyPending(JsonArray pending) {
        for (var el : pending) {
            JsonObject e = el.getAsJsonObject();
            String name = e.get("player").getAsString();
            String loc = e.get("loc").getAsString();
            Player p = Bukkit.getPlayerExact(name);
            if (p == null) continue;
            if (loc.equals(applied.get(name.toLowerCase()))) continue; // already restored
            restore(p, loc);
        }
    }

    private void restore(Player p, String loc) {
        applied.put(p.getName().toLowerCase(), loc);
        plugin.getServer().getScheduler().runTask(plugin, () -> {
            Location l = parseLoc(loc);
            if (l != null) p.teleport(safeY(l));
        });
        final UUID uuid = p.getUniqueId();
        plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> {
            // Pull the player's state from Redis (written by the source region) and apply it,
            // then delete it — so the handoff carries inventory/HP/XP, not just position.
            if (redis.available()) {
                String pd = redis.get(PD_KEY + uuid);
                if (pd != null && !pd.isEmpty()) {
                    try {
                        JsonObject o = GSON.fromJson(pd, JsonObject.class);
                        plugin.getServer().getScheduler().runTask(plugin, () -> { if (p.isOnline()) PlayerState.apply(p, o); });
                    } catch (Throwable ignored) {}
                    redis.del(PD_KEY + uuid);
                }
            }
            // ack so the panel stops re-sending it
            client.apiGet("/api/connector/pending?id=" + url(self) + "&ack=" + url(p.getName()));
        });
    }

    private static Location parseLoc(String s) {
        try {
            String[] a = s.split(";");
            World w = Bukkit.getWorld(a[3]);
            if (w == null) return null;
            Location l = new Location(w, Double.parseDouble(a[0]), Double.parseDouble(a[1]), Double.parseDouble(a[2]));
            if (a.length > 5) { l.setYaw(Float.parseFloat(a[4])); l.setPitch(Float.parseFloat(a[5])); }
            return l;
        } catch (Exception e) { return null; }
    }

    /**
     * Keep the exact handoff position when it's safe (continuous terrain on a shared seed means
     * the player's Y is valid), but never drop them inside a block or floating far up: if the feet
     * or head block is solid, or there's no ground for a while below, snap to the surface highest
     * block at that X/Z so they always land on top of the landscape rather than suffocating.
     */
    private static Location safeY(Location l) {
        World w = l.getWorld();
        if (w == null) return l;
        int x = l.getBlockX(), z = l.getBlockZ(), y = l.getBlockY();
        boolean feetClear = w.getBlockAt(x, y, z).isPassable();
        boolean headClear = w.getBlockAt(x, y + 1, z).isPassable();
        boolean groundNear = false;
        for (int dy = 1; dy <= 4; dy++) if (!w.getBlockAt(x, y - dy, z).isPassable()) { groundNear = true; break; }
        if (feetClear && headClear && groundNear) return l; // exact position is safe
        int top = w.getHighestBlockYAt(x, z);
        Location s = new Location(w, l.getX(), top + 1, l.getZ());
        s.setYaw(l.getYaw()); s.setPitch(l.getPitch());
        return s;
    }

    private static String str(JsonObject o, String k) {
        return (o.has(k) && !o.get(k).isJsonNull()) ? o.get(k).getAsString() : "";
    }
    private static String url(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
    }
}
