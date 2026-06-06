# Conduit

**Netzwerk-Orchestrierung für das c4g7 MC-Netzwerk auf Proxmox**

> Conduit ist der schlanke Controller, der auf Proxmox aufsetzt und die MC-Logik
> liefert (Servergruppen, Tasks, Autoscaling, Player-Routing). Er ersetzt die
> Game-Logik-Blackbox von CloudNet — die Infrastruktur (Isolation, Storage,
> Backup, Netz) kommt von Proxmox darunter.
>
> *Conduit* = im Minecraft ein Block, im Wortsinn „ein Kanal, der Fluss leitet und
> steuert". Genau das tut der Controller: er routet Spieler und steuert die Flotte.

*Stand 06/2026 · internes Konzeptpapier · Diskussionsgrundlage, keine finale Festlegung*

---

## 0. In einem Satz

CloudNet vermischt Infrastruktur und Game-Logik in einer Blackbox.
**Wir trennen das in zwei Ebenen:** Proxmox liefert die Infrastruktur,
**Conduit** liefert die MC-Logik obendrauf — offen, steuerbar, über eine API.

---

## 1. Ausgangslage

Aktuell läuft das Netzwerk über **CloudNet auf bare nodes** — eine Blackbox, die
nur den MC-Teil kennt und nichts vom Rest (DB, Website, Node-Auslastung, Backups).
Kein Hypervisor-Layer, keine echte Isolation, Backups und feste Services drumherum
von Hand zusammengehalten.

**Die Idee:** das komplette Netzwerk auf Proxmox vereinheitlichen — temporäre
Server (Lobbys), feste Server (SMP / Regionen), Datenbanken, Website und ein
zentrales Backup-System für den **gesamten Stack**. Statt verstreuter Einzelteile
eine durchgehende Infrastruktur mit voller Kontrolle.

### Warum nicht Pterodactyl?

Pterodactyl löst ein **anderes Problem**: es ist ein Einzelserver-Game-Panel mit
schöner Konsole, **kein Netzwerk-Orchestrator**.

| Was wir brauchen (CloudNet-Niveau)            | Kann Pterodactyl?            |
| --------------------------------------------- | ---------------------------- |
| Servergruppen & Tasks                         | Nein — kein Konzept dafür    |
| Dynamische / getemplatete Server (Autoscaling)| Nein                         |
| Proxy-aware Player-Routing                    | Nein                         |
| Gruppenweite Slot-Limits / Wartungsmodus      | Nein                         |
| Load Balancing / Live-Migration über Nodes    | Nein                         |
| Konsole + Datei-Manager pro Server (UI)       | Ja — das ist sein Kernzweck  |

CloudNet durch Pterodactyl ersetzen wäre ein **Downgrade auf der Game-Logik-Seite**.
Die hübsche Konsole lässt sich bei Bedarf trotzdem on-top betreiben (Wings im LXC) —
Ptero ist damit höchstens ein optionales UI-Layer, kein „statt Proxmox".

---

## 2. Architektur — vier Ebenen

Von oben (Spieler) nach unten (Hardware). Jede Ebene hat eine klare Aufgabe.

```
                          ┌─────────────┐
                          │   Spieler   │
                          └──────┬──────┘
                                 ▼
        ┌────────────────────────────────────────────────┐
        │  Velocity-Proxy(s) · Player-Ebene              │
        │  Routing · Load-Balancing · Slot-Limits · Wart.│
        └───────────────────────┬────────────────────────┘
                                 ▼
        ┌────────────────────────────────────────────────┐
        │  CONDUIT · Controller / Orchestrator           │   ← unser Eigenbau
        │  Servergruppen · Tasks · Autoscaling           │
        │  spricht Proxmox-API + Velocity-API            │
        └───────────────────────┬────────────────────────┘
                                 ▼
   ┌─────────────────────────────────────────────────────────┐
   │  PROXMOX CLUSTER   pmxe1 · pmxd2 · pmxf3                 │
   │  Isolation · Storage · VLAN · Live-Migration            │
   │                                                         │
   │  [Lobby-LXCs]      [Region/SMP]     [MariaDB / Redis]   │
   │   ZFS-Clone aus    feste, persist.   eigene LXCs        │
   │   Template                                              │
   │  [Website-LXC]     [pers. Daten]    [PBS — Backups]     │
   │                    Welten+DB auf     inkrementell,      │
   │                    eig. Dataset      ganzer Stack       │
   │                                                         │
   │  UDM Pro Max · VLANs · Firewall · Dual-WAN Failover     │
   │  Hardware · 3 Nodes · shared Storage f. Live-Migration  │
   └─────────────────────────────────────────────────────────┘
```

**Proxmox = das, worin es unschlagbar ist** (Isolation, Backup, DB, Website,
Reliability über den ganzen Stack). **Conduit** läuft schlank obendrauf und macht
nur die MC-spezifische Logik.

---

## 3. Bewertung nach den Faktoren

### ① Multi-Routing & Load Balancing

Zwei Ebenen, die zusammenspielen:

- **Node-Ebene (Proxmox):** verteilt Services über pmxe1/d2/f3, inkl.
  **Live-Migration** — laufenden Server bei Last oder Wartung *ohne Downtime*
  verschieben. **Anti-Affinity-Regeln** (z.B. nicht alle Lobbys auf einem Node) —
  in Conduit pro Task konfigurierbar (`placement.anti_affinity`).
- **Player-Ebene (Velocity):** routet Spieler auf die passende Instanz, mehrfach
  lauffähig, hinter der UDM Pro Max im Failover.

> CloudNet routet rein game-zentriert **ohne Hypervisor-Bewusstsein** — Conduit
> kennt beide Ebenen und bestimmt die Platzierung selbst.

### ② Template-System (dynamische Lobbys)

- **Proxmox-Template** (Paper/Velocity vorinstalliert) → Klonen via **ZFS-Clone**
  = quasi instant + nur Delta-Speicher.
- **Configs/Welt nicht fest im Template**, sondern beim Boot injiziert
  (cloud-init / Ansible), gezogen aus Git oder Object-Storage (Garage)
  → **Updates zentral** statt pro Server.
- **Autoscaling:** Conduits Watcher liest Player-Count über die Velocity-API und
  klont/zerstört Instanzen an Schwellwerten (`scale_up_at` / `scale_down_at`).

> **Eigenbau:** Genau dieser Watcher ist der einzige Teil, den CloudNet
> out-of-the-box vor uns hätte. → das ist *Conduit*.

### ③ Backups — Proxmox-Win

- **PBS** ist inkrementell, dedupliziert, geplant, pro LXC/VM — **Rollback per Klick**.
- Deckt den **ganzen Stack** ab: nicht nur Welten, sondern DB, Website,
  Proxy-Configs in *einem* System. Bei CloudNet müsste man Welt-Backup + DB-Dump +
  Website-Backup getrennt zusammenbasteln.
- **Persistente Daten** (Welten, DB) liegen auf **separatem Dataset** → der
  Server-Container kann weggeworfen und neu erstellt werden, Daten bleiben.

### ④ Verwaltung / Dashboard

Ein zentrales Panel für das komplette Netzwerk:

- Konsole pro Server (Spawn, Region, Lobby), starten / stoppen / klonen
- Spielerverwaltung, Slots, Wartungsmodus
- Status aller Nodes + Backups auf einen Blick

**Zwei Wege:**
- **(a)** Pterodactyl als reines UI-Layer drüber (Wings im LXC) — schnell fertig,
  aber begrenzt; zeigt nichts von Gruppen/Tasks.
- **(b)** Eigenes Conduit-Panel (passt zu c4g7-dev), das Proxmox-API + Velocity-API
  + DB bündelt → **ein Dashboard für alles** statt CloudNet-UI und Proxmox-UI getrennt.

### ⑤ Servergruppen & Tasks

Das ist die game-logische Ebene → lebt in **Conduit**, nicht in Proxmox direkt.

| CloudNet-Begriff       | Bei uns / in Conduit                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **Task**               | Template-ID + Regelsatz in Conduit (min/max Instanzen, Ressourcen, VLAN). „Spawn-Task startet unendlich Spawns" = Klon-Loop aus dem Template. |
| **Servergruppe**       | Logische Bündelung mehrerer Tasks. Abgebildet über **Resource Pools** (= Gruppe) + **Tags** (= Task-Zuordnung). |
| **Slot-Limit / Wartung** | Velocity-Ebene — der Proxy entscheidet, ob er noch routet bzw. neue Spieler annimmt (Conduit setzt das Flag). |

→ Konkret als Config: **[`examples/conduit.yaml`](examples/conduit.yaml)**

---

## 4. Durchlauf am Beispiel „Time SMP"

Time SMP = ein **Spawn-Task** (beliebig viele Spawns) + ein **Region-Task**
(hostet Regionen), zusammen in einer **Servergruppe**.
Komplett als Config modelliert in **[`examples/conduit.yaml`](examples/conduit.yaml)**,
der Lobby-Lebenszyklus Schritt für Schritt in
**[`examples/ablauf-lobby-autoscaling.md`](examples/ablauf-lobby-autoscaling.md)**.

**Setup (einmalig):**

| Element                     | Umsetzung                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Resource Pool `timesmp`     | = die Servergruppe. Klammert alle Container, gibt zentral Limits / Rechte.            |
| Template `tmpl-spawn`       | Paper + Spawn-Plugins, Welt leer/aus Git. Tag: `task=spawn`                           |
| Template `tmpl-region`      | Paper + Region-Setup. Persistente Welt auf eigenem Dataset. Tag: `task=region`        |

**Spawn-Task — dynamisch (Lobby-artig):** `min=1, max=∞, players_per_instance=80`.
Andrang steigt → Conduit klont `tmpl-spawn` (ZFS-Clone, instant), neuer LXC bootet,
registriert sich automatisch bei Velocity. Andrang fällt → Instanz wird geleert
(Velocity routet keine neuen Spieler mehr drauf) und zerstört — kein Datenverlust,
weil Spawn zustandslos ist.

**Region-Task — fest (persistent):** feste Anzahl, kein Autoscaling. Jede Region =
eigener LXC mit eigener Welt auf separatem Dataset. Bei Last/Wartung Live-Migration
ohne Downtime. Nightly PBS-Backup pro Region.

**Gruppen-Features (Time SMP als Ganzes):**
- **Player-Slot-Limit:** Velocity zählt über die ganze Gruppe und stoppt Routing am Limit.
- **Wartungsmodus:** Conduit-Flag setzt die Gruppe auf `maintenance` → Velocity weist
  neue Spieler ab, Admins kommen rein, laufende Server bleiben unangetastet.

---

## 5. Was Conduit konkret tut (Komponenten)

| Komponente        | Aufgabe                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| **conduitd**      | Daemon. Liest `conduit.yaml`, hält Soll/Ist der Flotte ab, treibt die APIs.  |
| **Watcher/Scaler**| Pollt Velocity-Player-Counts, entscheidet Scale-up/-down nach Schwellwerten. |
| **Proxmox-Driver**| Klonen, Starten, Stoppen, Live-Migration, Pool/Tag-Verwaltung über die API.  |
| **Velocity-Bridge**| Registriert/entfernt Server, setzt Routing, Slot-Limits, Wartungsmodus.     |
| **conduit-cli**   | Admin-CLI: `conduit scale`, `conduit maintenance on timesmp`, `conduit ps`.  |
| **Panel** (opt.)  | Web-Dashboard für alles (Faktor ④, Variante b).                              |

---

## 6. Ehrliche Abwägung & Fazit

**Was kostet uns das?** CloudNet kann die reinen Game-Features (dynamische Server,
Slots, Wartung) out-of-the-box — den Controller/Autoscaler (= **Conduit**) müssen wir
bauen. **Das ist der einzige echte Mehraufwand.**

**Was gewinnen wir?** Ein **einheitliches System für alles** (MC + DB + Website +
Backup), echte Isolation, Backup-Reliability über den ganzen Stack, volle
API-Kontrolle und Live-Migration — statt einer MC-only Blackbox.

**Die Basis ist ohnehin gesetzt:** Proxmox gewinnt bei Backup, DB, Website und
Isolation klar. Offen bleibt nur, ob wir die Game-Orchestrierung
**(a)** selbst bauen (Conduit) oder **(b)** einen leichten Orchestrator innerhalb
von Proxmox-VMs für den MC-Layer weiterlaufen lassen. Beides ist möglich — am
Beispiel Time SMP oben komplett durchgespielt.

---

## 7. Möglicher Phasenplan (Vorschlag)

| Phase | Inhalt                                                                                   |
| ----- | ---------------------------------------------------------------------------------------- |
| **0** | Proxmox-Cluster + shared Storage + PBS aufsetzen. DB/Website/Velocity als LXC. (reine Infra, noch kein Conduit) |
| **1** | Statische Server (Regionen) manuell als LXC + nightly PBS-Backup. Velocity routet fest. |
| **2** | Templates + ZFS-Clone-Workflow + cloud-init-Injection. Manuelles Klonen funktioniert.   |
| **3** | `conduitd` MVP: liest `conduit.yaml`, klont/zerstört Spawns über Proxmox-API, Velocity-Bridge. |
| **4** | Watcher/Autoscaler nach Player-Count. Gruppen-Slot-Limit + Wartungsmodus.                |
| **5** | Panel/Dashboard (Variante b) oder Ptero-UI on-top (Variante a).                          |

> Wichtig: schon **ab Phase 1** ist Proxmox ein Gewinn (Backup, Isolation, DB,
> Website). Conduit kommt schrittweise drauf — kein Big-Bang nötig.
