# Ablauf: Lobby-Autoscaling (Spawn-Task)

Der Lebenszyklus einer dynamischen Spawn-Instanz, Schritt für Schritt — das
Stück, das CloudNet out-of-the-box kann und das **Conduit** für uns übernimmt.
Bezug: Task `spawn` aus [`conduit.yaml`](conduit.yaml).

---

## Scale-up — Andrang steigt

```
 Spieler           Velocity            Conduit (Watcher)        Proxmox
   │                  │                      │                     │
   │  join ──────────►│                      │                     │
   │                  │ player_count ───────►│ poll (alle 5s)      │
   │                  │                      │                     │
   │                  │   spawn-1 bei 82% ───┤ > scale_up_at(80%)  │
   │                  │                      │  clone tmpl-spawn ─►│ ZFS-Clone
   │                  │                      │                     │ (instant,
   │                  │                      │                     │  nur Delta)
   │                  │                      │   start spawn-2 ───►│ LXC boot
   │                  │                      │                     │ + cloud-init
   │                  │                      │                     │   zieht Config
   │                  │  register spawn-2 ◄──┤                     │   aus Git
   │                  │                      │                     │
   │  ◄── neue Spieler werden auf spawn-2 geroutet ────────────────│
```

**Schritte:**
1. Spieler joinen, Velocity meldet steigenden `player_count` für den Spawn-Task.
2. Conduits Watcher pollt (z.B. alle 5 s) und sieht: spawn-1 bei 82 % → über
   `scale_up_at: 0.80`.
3. Conduit klont `tmpl-spawn` per **ZFS-Clone** → quasi instant, nur Delta-Speicher.
4. Der neue LXC (spawn-2) bootet, zieht Config/Welt via **cloud-init** aus Git
   (nichts ist fest im Template → zentrale Updates).
5. spawn-2 **registriert sich automatisch bei Velocity** → neue Spieler werden
   dorthin geroutet. Anti-Affinity sorgt dafür, dass spawn-2 möglichst auf einem
   anderen Node landet als spawn-1.

---

## Scale-down — Andrang fällt

```
 Conduit (Watcher)            Velocity                 Proxmox
   │                            │                         │
   │ spawn-2 bei 15% ──────────►│ < scale_down_at(20%)    │
   │  drain spawn-2 ───────────►│ kein Neu-Routing mehr   │
   │                            │  (laufende bleiben)     │
   │  warte drain_timeout 120s  │                         │
   │  ...Instanz leer...        │                         │
   │  deregister spawn-2 ──────►│                         │
   │  destroy spawn-2 ────────────────────────────────────►│ LXC weg
   │                            │                         │ (kein Daten-
   │                            │                         │  verlust:
   │                            │                         │  zustandslos)
```

**Schritte:**
1. Last fällt unter `scale_down_at: 0.20`.
2. Conduit setzt spawn-2 auf **drain**: Velocity routet **keine neuen** Spieler
   mehr dorthin, laufende dürfen bleiben.
3. Nach `drain_timeout` (oder sobald leer) wird spawn-2 bei Velocity abgemeldet
   und der LXC **zerstört**.
4. **Kein Datenverlust**, weil Spawn `persistent: false` / zustandslos ist —
   die Welt war leer/aus Git, es gibt nichts zu sichern.

> `min: 1` garantiert, dass immer mindestens ein Spawn übrig bleibt.

---

## Unterschied zum Region-Task (fest)

Der Region-Task macht **nichts davon**: feste Anzahl, kein Autoscaling.
Statt Wegwerfen gilt dort:

- Welt liegt auf **separatem Dataset** (`tank/worlds/region`) → bleibt erhalten,
  auch wenn der Container neu erstellt wird.
- Bei Last/Wartung: **Live-Migration** auf einen anderen Node, ohne Downtime
  (möglich dank shared Storage).
- **Nightly PBS-Backup**, inkrementell, Rollback per Klick.

Das ist genau die Trennung, um die es geht: **zustandslos = skalieren/wegwerfen,
zustandsbehaftet = migrieren/backuppen.** Conduit kennt für jeden Task, welcher
Fall gilt (`persistent: true/false`).
