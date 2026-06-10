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
  /** task names currently under maintenance (own flag or any ancestor subgroup's) — the proxy
   *  denies connects to matching servers unless conduit.maintenance.bypass[.<task>] */
  maintenanceTasks: string[];
  /** network player cap — the proxy DENIES login at capacity (cheap, no backend connect) */
  maxPlayers: number;
  /** custom kick message when the network is full (legacy & colors) */
  fullMessage: string;
  /** per-subgroup player caps: the proxy sums online across `tasks` and denies connects into
   *  them at the limit (bypass: conduit.full.bypass). Nested subgroups included. */
  limits: { id: string; tasks: string[]; limit: number; message: string }[];
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

  // Per-task maintenance: a task is closed when its own flag OR any ancestor subgroup's flag
  // is set (subgroups nest via parentId; group maintenance stays the network-wide login deny).
  // Names, because the proxy matches registered servers by task-name prefix.
  const sgsOf = (gId: string) => db.groups.find((g) => g.id === gId)?.subgroups ?? [];
  const chainOf = (gId: string, sgId: string | undefined) => {
    const all = sgsOf(gId);
    const chain: typeof all = [];
    let cur = sgId;
    for (let i = 0; cur && i < 50; i++) {
      const sg = all.find((s) => s.id === cur);
      if (!sg) break;
      chain.push(sg);
      cur = sg.parentId;
    }
    return chain;
  };
  const maintenanceTasks: string[] = [];
  for (const t of db.tasks) {
    if (proxy && t.groupId !== proxy.groupId) continue;
    if (t.maintenance || chainOf(t.groupId, t.subgroupId).some((s) => s.maintenance)) maintenanceTasks.push(t.name);
  }

  // Per-subgroup player caps: each limited subgroup contributes the task names under it
  // (including nested children) so the proxy can sum their online counts and deny connects
  // at the cap — the cheap "storm protection" reject before any backend connection.
  const limits: ProxyConfig["limits"] = [];
  if (proxy) {
    for (const sg of sgsOf(proxy.groupId)) {
      if (!sg.slotLimit || sg.slotLimit <= 0) continue;
      const tasks = db.tasks
        .filter((t) => t.groupId === proxy.groupId && chainOf(t.groupId, t.subgroupId).some((s) => s.id === sg.id))
        .map((t) => t.name);
      if (tasks.length === 0) continue;
      limits.push({
        id: sg.id,
        tasks,
        limit: sg.slotLimit,
        message: sg.fullMessage ?? `&8[&bConduit&8] &7${sg.name} &cis full.`,
      });
    }
  }

  const motd = (proxy?.motd ?? "").split("\n");
  return {
    fallbacks,
    defaultFallback: fallbacks[0]?.task ?? null,
    motdLine1: motd[0] ?? "",
    motdLine2: motd[1] ?? "",
    maintenance: group?.maintenance ?? false,
    maintenanceTasks,
    fullMessage: group?.fullMessage ?? "&8[&bConduit&8] &cThe network is full.",
    limits,
    maxPlayers: group?.slotLimit ?? 1000,
    tablistHeader: "&b%proxy%\n&7on &f%server%",
    tablistFooter: "&7%online%&8/&7%max% online &8• &7%ping%ms",
  };
}
