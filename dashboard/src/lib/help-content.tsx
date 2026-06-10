import type { ReactNode } from "react";

/**
 * Central help/wiki content. Each topic has a stable `id` (referenced by <HelpButton topic="…">),
 * a category for grouping, a title, and a short body. Keep entries concise and practical — the
 * help center renders them grouped by category and jumps to whichever topic was clicked.
 */
export type HelpTopic = { id: string; category: string; title: string; body: ReactNode };

export const HELP_TOPICS: HelpTopic[] = [
  /* ── Scaling & autoscale ─────────────────────────────────────────────── */
  {
    id: "mode", category: "Scaling & autoscale", title: "Static vs Dynamic",
    body: (
      <>
        <p><b>Static</b> runs a fixed number of instances you set with <i>desired</i>. Use it for
        servers with persistent data (SMP worlds, hubs, databases) — they aren&apos;t spun up/down by load.</p>
        <p><b>Dynamic</b> autoscales: the controller adds and removes instances based on live player
        load, between your <i>min</i> and <i>max</i>. Use it for minigames/lobbies that should grow
        on demand and shrink when empty.</p>
      </>
    ),
  },
  {
    id: "players-per-instance", category: "Scaling & autoscale", title: "Players / instance",
    body: (
      <>
        <p>The target capacity of <b>one</b> instance — the autoscaler runs enough instances so none
        exceeds this. With <code>50</code>: 0 players → just the <i>min</i> floor; ~1–50 → 2 (one
        filling + a spare for joins); 51–100 → 3; and so on (<code>ceil(players / 50) + 1</code>).</p>
        <p>It also sets each server&apos;s in-game slot count (<code>max-players</code>). Only affects
        dynamic tasks.</p>
      </>
    ),
  },
  {
    id: "min-max-desired", category: "Scaling & autoscale", title: "Min / Max / Desired",
    body: (
      <>
        <p><b>Desired</b> — static only: how many instances to keep running.</p>
        <p><b>Min</b> — the always-on floor (dynamic never scales below this; keep 1 for an
        always-joinable server).</p>
        <p><b>Max</b> — the hard ceiling (0 = unbounded). The controller never provisions past it.</p>
      </>
    ),
  },
  {
    id: "scale-up-percent", category: "Scaling & autoscale", title: "Scale-up percent",
    body: (
      <p>Scale <i>earlier</i> than full. The scale threshold is <code>players-per-instance ×
      this%</code>. At <code>80%</code> with 50/inst, a new instance is added once a server passes
      40 players — so there&apos;s always headroom instead of waiting for one to fill. Default 100%.</p>
    ),
  },
  {
    id: "prepared-pool", category: "Scaling & autoscale", title: "Prepared pool (warm)",
    body: (
      <p>Keeps this many pre-cloned, <b>stopped</b> instances ready. A scale-up <i>starts</i> a warm
      one (near-instant) instead of cloning fresh, then refills the pool in the background. Needs a
      golden image built for the egg. CloudNet calls this <i>preparedServices</i>.</p>
    ),
  },
  {
    id: "scale-down-after", category: "Scaling & autoscale", title: "Scale-down after (idle)",
    body: (
      <p>An empty instance is only removed after it&apos;s been idle this many seconds — prevents
      flapping when players briefly leave. Mirrors CloudNet&apos;s auto-stop. Default 60s.</p>
    ),
  },
  {
    id: "spawn-cooldown", category: "Scaling & autoscale", title: "Spawn cooldown",
    body: <p>Minimum seconds between provisioning new instances, so a burst of joins doesn&apos;t create a thundering herd of containers at once.</p>,
  },
  {
    id: "split-over-nodes", category: "Scaling & autoscale", title: "Split over nodes",
    body: <p>Spread this task&apos;s instances across the Proxmox nodes (for redundancy/balance) instead of packing them onto one node.</p>,
  },
  {
    id: "node-pin", category: "Scaling & autoscale", title: "Pinned node",
    body: <p>Force this task&apos;s instances onto a specific Proxmox node. Leave empty to auto-pick the least-loaded node each time.</p>,
  },

  /* ── Resources ───────────────────────────────────────────────────────── */
  {
    id: "resources", category: "Resources", title: "Cores / Memory / Disk",
    body: (
      <p>Per-instance container resources. <b>Memory</b> is the RAM cap (MB) — the JVM heap is sized
      from it. Changing these affects <i>newly provisioned</i> instances; existing containers
      aren&apos;t resized live. Size memory to the workload — too low and the server thrashes/OOMs.</p>
    ),
  },
  {
    id: "persistent", category: "Resources", title: "Persistent",
    body: (
      <p>Marks that instances own data that must survive. Persistent instances are <b>never
      auto-destroyed</b> by the controller (scale-down/GC skip them) — removing one is an explicit
      action. Static SMP worlds and databases are persistent; ephemeral minigames are not.</p>
    ),
  },

  /* ── World sharding ──────────────────────────────────────────────────── */
  {
    id: "sharding-enable", category: "World sharding", title: "Seamless world (sharding)",
    body: (
      <>
        <p>Splits ONE world across this task&apos;s instances along the X axis — each instance owns a
        vertical strip and players are handed off seamlessly (keeping position + inventory) when
        they cross a boundary. Same seed everywhere ⇒ one continuous world. Inspired by TMregion.</p>
        <p>Enabling reboots all region servers and regenerates their worlds on one shared seed
        (current world data is replaced) — so it&apos;s for fresh worlds, not populated ones.</p>
      </>
    ),
  },
  {
    id: "shard-chunks", category: "World sharding", title: "Chunks / region",
    body: (
      <p>How wide each instance&apos;s strip is, in overworld chunks (1 chunk = 16 blocks). Wider
      strips = more world per server, fewer boundary handoffs. The nether strip is scaled 1:8 to
      match. The full world border = strip × number of regions.</p>
    ),
  },
  {
    id: "shard-seam", category: "World sharding", title: "Seam buffer",
    body: <p>A no-build buffer (in blocks) at each strip boundary — players can&apos;t place/break inside it, since the neighbouring region owns those blocks. Keeps the seam clean. Default 30.</p>,
  },
  {
    id: "shard-splitend", category: "World sharding", title: "Split the End",
    body: <p>Also shard the End dimension (scaled like the overworld). Off = the End stays on a single server.</p>,
  },
  {
    id: "shard-seed", category: "World sharding", title: "Shared seed",
    body: <p>All region instances generate with this one seed so the terrain is continuous across strips. Leave blank to auto-generate, or set your own. Changing it regenerates the worlds.</p>,
  },
  {
    id: "redis", category: "World sharding", title: "Redis (player sync)",
    body: (
      <>
        <p>Carries player inventory/HP/XP/effects across shard handoffs. Deploy a Redis task
        (1 works; 2+ for redundancy).</p>
        <p><b>Self-configuring:</b> the controller makes the lowest-vmid instance the primary and
        auto-replicates the rest (failover down the list). The password is derived from the network
        secret, so server and connectors agree with no setup.</p>
        <p><b>How servers use it:</b> the panel hands each sharded backend the Redis endpoints +
        password via its heartbeat config — no hardcoded address. On a boundary cross the source
        writes the player&apos;s state to <code>conduit:pd:&lt;uuid&gt;</code> (short TTL); the
        destination applies it on arrival and deletes it.</p>
      </>
    ),
  },

  /* ── Networking & routing ────────────────────────────────────────────── */
  {
    id: "fronts", category: "Networking & routing", title: "Backend routing (fronts)",
    body: (
      <p>For a proxy task: which backend tasks it routes players to. Fronted <i>lobby</i> tasks
      become fallbacks (the first is the default hub players land on). Changes apply live via a
      Velocity reload — no kicks.</p>
    ),
  },
  {
    id: "motd", category: "Networking & routing", title: "MOTD",
    body: <p>The server-list message shown in the multiplayer menu. Supports <code>&amp;</code> colour/format codes. Applied to this task&apos;s instances (proxy = the network MOTD).</p>,
  },

  /* ── Players & groups ────────────────────────────────────────────────── */
  {
    id: "slot-limit", category: "Players & groups", title: "Group slot limit",
    body: <p>The network-wide player cap for the group (the proxy&apos;s <code>show-max-players</code>). Independent of per-instance capacity.</p>,
  },
  {
    id: "maintenance", category: "Players & groups", title: "Maintenance mode",
    body: <p>When on, the proxy blocks non-permitted players from joining the group (a maintenance MOTD/kick), while operators can still get in. Use during upgrades.</p>,
  },

  /* ── Templates & assets ──────────────────────────────────────────────── */
  {
    id: "seed-assets", category: "Templates & assets", title: "World / plugins / assets",
    body: (
      <p>Seed content copied into each fresh instance: a world (URL or an uploaded asset), plugin
      jars, and a server icon. Uploaded panel assets can be picked directly — you don&apos;t have to
      paste URLs. Applied on first provision; existing worlds aren&apos;t clobbered.</p>
    ),
  },
];

export const HELP_BY_ID = new Map(HELP_TOPICS.map((t) => [t.id, t]));
