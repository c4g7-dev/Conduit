/**
 * Build the proxy connector config (CloudNet SyncProxy + Bridge-fallback equivalent) from
 * live Conduit state, so the connector plugin stays generic and behaviour is configured here.
 *
 *   fallbacks   — ordered lobby tasks the proxy fronts (server-name prefix the plugin matches),
 *                 each with an optional permission gate; the first is the default hub.
 *   motd        — two MOTD lines (from the proxy task's motd) + maintenance flag (from the group).
 *   maxPlayers  — slot limit (group.slotLimit).
 *   tablist     — header/footer with placeholders (%proxy% %server% %task% %online% %max% %ping%).
 */
import { getDB } from "./store";
import { blueprint, loadBlueprints } from "./blueprints";

export type ProxyConfig = {
  fallbacks: { task: string; permission: string | null }[];
  defaultFallback: string | null;
  motdLine1: string;
  motdLine2: string;
  maintenance: boolean;
  maxPlayers: number;
  tablistHeader: string;
  tablistFooter: string;
};

export async function buildProxyConfig(taskName: string, groupId: string): Promise<ProxyConfig> {
  await loadBlueprints();
  const db = await getDB();
  // Find the proxy task (by name, scoped to its group when possible).
  const proxy = db.tasks.find((t) => t.name === taskName && (!groupId || t.groupId === groupId))
    ?? db.tasks.find((t) => t.name === taskName);
  const group = proxy ? db.groups.find((g) => g.id === proxy.groupId) : undefined;

  // Fronted backend tasks that are lobbies become fallbacks (ordered as configured).
  const fronts = proxy?.fronts ?? [];
  const fallbacks: { task: string; permission: string | null }[] = [];
  for (const id of fronts) {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) continue;
    const role = blueprint(t.blueprintId)?.role;
    if (role === "lobby") fallbacks.push({ task: t.name, permission: null });
  }
  // If no lobby is explicitly fronted, fall back to any lobby task in the same group.
  if (fallbacks.length === 0 && proxy) {
    for (const t of db.tasks) {
      if (t.groupId === proxy.groupId && blueprint(t.blueprintId)?.role === "lobby") fallbacks.push({ task: t.name, permission: null });
    }
  }

  const motd = (proxy?.motd ?? "").split("\n");
  return {
    fallbacks,
    defaultFallback: fallbacks[0]?.task ?? null,
    motdLine1: motd[0] ?? "",
    motdLine2: motd[1] ?? "",
    maintenance: group?.maintenance ?? false,
    maxPlayers: group?.slotLimit ?? 1000,
    tablistHeader: "&b%proxy%\n&7on &f%server%",
    tablistFooter: "&7%online%&8/&7%max% online &8• &7%ping%ms",
  };
}
