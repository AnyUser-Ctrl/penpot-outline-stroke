# Outline Stroke – Penpot Plugin

Wandelt den Stroke ausgewählter Shapes in einen gefüllten Pfad um — wie „Outline Stroke" in Illustrator/Figma. Workaround für das offene Penpot-Feature [Taiga US #2956](https://tree.taiga.io/project/penpot/us/2956).

## Installation (selbstgehostetes Penpot, Docker)

**1. Plugin-Ordner auf den Server legen**

Den kompletten Ordner `penpot-outline-stroke/` neben deine Penpot-`docker-compose.yaml` kopieren.

**2. Statischen Server starten**

```bash
docker compose -f docker-compose.yaml -f penpot-outline-stroke/docker-compose.plugin.yml up -d
```

(Alternativ: den Service-Block aus `docker-compose.plugin.yml` in deine bestehende Compose-Datei kopieren — Pfade ggf. anpassen.)

Check: `http://<server>:9400/manifest.json` muss im Browser das Manifest anzeigen.

**3. Plugins in Penpot aktivieren (falls nötig)**

In der Penpot-Compose-Datei beim Frontend prüfen, dass `PENPOT_FLAGS` `enable-plugins` enthält:

```yaml
environment:
  - PENPOT_FLAGS=... enable-plugins
```

Danach `docker compose up -d` zum Neuerstellen. In neueren Penpot-Versionen sind Plugins bereits standardmäßig aktiv — wenn Schritt 4 funktioniert, kannst du das überspringen.

**4. Plugin installieren**

In Penpot eine Datei öffnen → `Ctrl+Alt+P` (Plugin-Manager) → URL eintragen:

```
http://<server>:9400/manifest.json
```

`<server>` = Adresse aus Sicht deines **Browsers** (z. B. `localhost`, wenn Penpot auf demselben Rechner läuft).

## Nutzung

1. Shape(s) mit Stroke auswählen — Pfade, Rechtecke, Ellipsen, Booleans. **Gruppen/Boards werden rekursiv durchsucht**, alle enthaltenen Strokes mitgenommen.
2. Plugin öffnen (Plugin-Menü → „Outline Stroke").
3. Optionen wählen → **Stroke in Pfad umwandeln**.
4. Ergebnis: **eine** gefüllte Form „Outline", die die gesamte Auswahl repräsentiert.

**Optionen:**
- **Original behalten** – Ausgangs-Shape bleibt erhalten.
- **Ecken (Join)** – Gehrung / Rund / Abgeflacht (wirkt bei geschlossenen Formen).
- **Enden (Cap)** – Rund / Flach / Quadratisch.
- **Platzierung** – „Neben Original" (versetzt, kein Overlap) oder „An Ort" (deckungsgleich).

Alle Outlines einer Auswahl werden per Boolean-Union **zu einer Form pro Farbe** verschmolzen — überlappende Duplikate verschwinden dabei automatisch. Unterstützt: Strichstärke, Ausrichtung (zentriert/innen/außen), gefüllte Ringe aus geschlossenen Shapes.

## Selbsttest

`http://<server>:9400/test.html` öffnen — prüft 7 Testfälle inkl. Invarianten (gleichmäßige Breite, saubere Caps), die Geometrie-Regressionen sofort fangen. Alles grün = Logik OK.

## Technik-Hinweise

- Die Stroke-Outline wird **analytisch aus der Mittellinie** berechnet (flatten → Normalen-Offset → Bogen-Caps), nicht über die fehleranfällige Stroke-Funktion von `paperjs-offset` — dadurch keine Keile/Dellen an gekrümmten Enden.
- Plugin-Code läuft in Penpots **SES**-Sandbox: keine `-->`/`<!--`-Sequenzen im Code (auch nicht in Kommentaren).

## Grenzen

- Nur der **erste** Stroke eines Shapes wird umgewandelt.
- Gestrichelte/gepunktete Strokes → werden als durchgezogen behandelt.
- Gradient-Strokes → Füllung wird Volltonfarbe des ersten Stops.
- Rotierte Ellipsen/Rechtecke werden achsenparallel umgewandelt (mit Hinweis).

## Offline / ohne CDN

`paper-core.min.js` **und** `paperjs-offset.min.js` liegen bereits in `vendor/` — das Plugin läuft also out-of-the-box ohne Internet. Die CDN-Einträge in `index.html` sind nur Fallback.

## Stolperfallen

- **HTTPS-Penpot + HTTP-Plugin = blockiert** (Mixed Content). Dann das Plugin ebenfalls hinter deinen Reverse-Proxy mit TLS legen (z. B. `plugins.deine-domain.tld`) und diese URL im Plugin-Manager verwenden.
- Nach Änderungen an den Plugin-Dateien: Plugin im Manager entfernen und neu hinzufügen (oder Hard-Reload).

## Dateien

| Datei | Zweck |
|---|---|
| `manifest.json` | Plugin-Manifest für Penpot |
| `plugin.js` | Sandbox-Code: liest Selektion, erzeugt neue Shapes |
| `index.html` | Plugin-UI + Berechnung |
| `outline-core.js` | Kernlogik: analytischer Stroke-Outline + Boolean-Ops (paper.js) |
| `vendor/paper-core.min.js` | paper.js (MIT, paperjs/paper.js) |
| `vendor/paperjs-offset.min.js` | Offset-Library (MIT, glenzli/paperjs-offset) |
| `test.html` | Selbsttest im Browser |
| `nginx.conf`, `docker-compose.plugin.yml` | Hosting |
