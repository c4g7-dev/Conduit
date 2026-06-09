package dev.c4g7.conduit.paper;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import org.bukkit.GameMode;
import org.bukkit.attribute.Attribute;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;
import org.bukkit.util.io.BukkitObjectInputStream;
import org.bukkit.util.io.BukkitObjectOutputStream;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.Base64;

/**
 * Snapshot/restore of a player's state for seamless-world handoffs (the Conduit-native HuskSync
 * equivalent). Captures inventory + armor + ender chest + vitals + XP + gamemode + potion effects
 * to a JSON blob (item arrays are BukkitObjectStream-serialized → base64) that rides through Redis
 * between regions, so crossing a shard boundary carries the whole player, not just their position.
 */
final class PlayerState {
    private PlayerState() {}

    static String capture(Player p) {
        JsonObject o = new JsonObject();
        PlayerInventory inv = p.getInventory();
        o.addProperty("inv", encodeItems(inv.getContents()));
        o.addProperty("armor", encodeItems(inv.getArmorContents()));
        o.addProperty("extra", encodeItems(new ItemStack[]{ inv.getItemInOffHand() }));
        o.addProperty("ender", encodeItems(p.getEnderChest().getContents()));
        o.addProperty("heldSlot", inv.getHeldItemSlot());
        o.addProperty("health", p.getHealth());
        try {
            var a = p.getAttribute(Attribute.GENERIC_MAX_HEALTH);
            if (a != null) o.addProperty("maxHealth", a.getBaseValue());
        } catch (Throwable ignored) {}
        o.addProperty("food", p.getFoodLevel());
        o.addProperty("saturation", p.getSaturation());
        o.addProperty("exp", p.getExp());
        o.addProperty("level", p.getLevel());
        o.addProperty("air", p.getRemainingAir());
        o.addProperty("fire", p.getFireTicks());
        o.addProperty("gamemode", p.getGameMode().name());
        JsonArray fx = new JsonArray();
        for (PotionEffect e : p.getActivePotionEffects()) {
            JsonObject ej = new JsonObject();
            ej.addProperty("type", e.getType().getName());
            ej.addProperty("amp", e.getAmplifier());
            ej.addProperty("dur", e.getDuration());
            ej.addProperty("ambient", e.isAmbient());
            ej.addProperty("particles", e.hasParticles());
            fx.add(ej);
        }
        o.add("effects", fx);
        return o.toString();
    }

    static void apply(Player p, JsonObject o) {
        PlayerInventory inv = p.getInventory();
        ItemStack[] main = decodeItems(str(o, "inv"));
        if (main != null) inv.setContents(main);
        ItemStack[] armor = decodeItems(str(o, "armor"));
        if (armor != null) inv.setArmorContents(armor);
        ItemStack[] extra = decodeItems(str(o, "extra"));
        if (extra != null && extra.length > 0) inv.setItemInOffHand(extra[0]);
        ItemStack[] ender = decodeItems(str(o, "ender"));
        if (ender != null) p.getEnderChest().setContents(ender);
        if (o.has("heldSlot")) inv.setHeldItemSlot(o.get("heldSlot").getAsInt());
        try {
            if (o.has("maxHealth")) {
                var a = p.getAttribute(Attribute.GENERIC_MAX_HEALTH);
                if (a != null) a.setBaseValue(o.get("maxHealth").getAsDouble());
            }
            if (o.has("health")) p.setHealth(Math.max(0.5, o.get("health").getAsDouble()));
        } catch (Throwable ignored) {}
        if (o.has("food")) p.setFoodLevel(o.get("food").getAsInt());
        if (o.has("saturation")) p.setSaturation((float) o.get("saturation").getAsDouble());
        if (o.has("exp")) p.setExp((float) o.get("exp").getAsDouble());
        if (o.has("level")) p.setLevel(o.get("level").getAsInt());
        if (o.has("air")) p.setRemainingAir(o.get("air").getAsInt());
        if (o.has("fire")) p.setFireTicks(o.get("fire").getAsInt());
        if (o.has("gamemode")) { try { p.setGameMode(GameMode.valueOf(o.get("gamemode").getAsString())); } catch (Throwable ignored) {} }
        for (PotionEffect e : p.getActivePotionEffects()) p.removePotionEffect(e.getType());
        if (o.has("effects")) for (var el : o.getAsJsonArray("effects")) {
            JsonObject e = el.getAsJsonObject();
            PotionEffectType t = PotionEffectType.getByName(e.get("type").getAsString());
            if (t != null) p.addPotionEffect(new PotionEffect(t, e.get("dur").getAsInt(), e.get("amp").getAsInt(),
                    e.has("ambient") && e.get("ambient").getAsBoolean(), !e.has("particles") || e.get("particles").getAsBoolean()));
        }
        p.updateInventory();
    }

    private static String encodeItems(ItemStack[] items) {
        try (ByteArrayOutputStream bos = new ByteArrayOutputStream();
             BukkitObjectOutputStream out = new BukkitObjectOutputStream(bos)) {
            out.writeObject(items);
            out.flush();
            return Base64.getEncoder().encodeToString(bos.toByteArray());
        } catch (Exception e) { return ""; }
    }

    private static ItemStack[] decodeItems(String b64) {
        if (b64 == null || b64.isEmpty()) return null;
        try (ByteArrayInputStream bis = new ByteArrayInputStream(Base64.getDecoder().decode(b64));
             BukkitObjectInputStream in = new BukkitObjectInputStream(bis)) {
            return (ItemStack[]) in.readObject();
        } catch (Exception e) { return null; }
    }

    private static String str(JsonObject o, String k) {
        return (o.has(k) && !o.get(k).isJsonNull()) ? o.get(k).getAsString() : null;
    }
}
