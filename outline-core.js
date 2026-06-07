/**
 * Outline-Stroke-Kernlogik (läuft im Browser, braucht paper.js + PaperOffset).
 * Wird von index.html (Plugin-UI) und test.html (Selbsttest) genutzt.
 */
(function (global) {
  'use strict';

  function isClosed(item) {
    if (item instanceof paper.CompoundPath) {
      return item.children.every(function (c) { return c.closed; });
    }
    return !!item.closed;
  }

  /**
   * Importierte SVGs (z.B. Kreise/Ellipsen) liegen oft als Pfad OHNE 'Z' vor –
   * Start- und Endpunkt fallen nur zusammen. Solche Pfade als geschlossen
   * behandeln, sonst entsteht am Nahtpunkt eine Cap-Kerbe statt sauberem Ring.
   */
  function closeCoincident(item) {
    var subs = (item instanceof paper.CompoundPath) ? item.children : [item];
    subs.forEach(function (p) {
      if (!p.closed && p.segments.length > 2) {
        if (p.firstSegment.point.getDistance(p.lastSegment.point) < 0.05) {
          p.firstSegment.handleIn = p.lastSegment.handleIn; // Schluss-Kurve erhalten
          p.lastSegment.remove();
          p.closed = true;
        }
      }
    });
  }

  /**
   * Liefert die bereinigte Punktfolge eines geflatteten Pfades (ohne
   * aufeinanderfolgende Duplikate), als Basis für den analytischen Offset.
   */
  function flattenPoints(path, r) {
    var flat = path.clone({ insert: false });
    // Auflösung an die Strichbreite koppeln (feiner bei dünnem Stroke).
    flat.flatten(Math.min(0.5, Math.max(0.15, r / 40)));
    var raw = flat.segments.map(function (s) { return s.point; });
    flat.remove();
    var pts = [];
    for (var i = 0; i < raw.length; i++) {
      if (pts.length === 0 || raw[i].getDistance(pts[pts.length - 1]) > 1e-4) {
        pts.push(raw[i]);
      }
    }
    return pts;
  }

  /** Hängt eine Kappe (round/square/butt) an das offene Band an. */
  function addCap(band, endPt, prevPt, fromOff, toOff, r, cap) {
    if (cap === 'round') {
      var t = endPt.subtract(prevPt).normalize(r);
      var arc = new paper.Path.Arc(fromOff, endPt.add(t), toOff);
      band.addSegments(arc.segments.map(function (s) { return s.clone(); }));
      arc.remove();
    } else if (cap === 'square') {
      var t2 = endPt.subtract(prevPt).normalize(r);
      band.add(new paper.Segment(fromOff.add(t2)));
      band.add(new paper.Segment(toOff.add(t2)));
    }
    // butt: nichts – die Schließung zieht eine gerade Linie fromOff -> toOff
  }

  /**
   * Stroke -> Füllung für einen OFFENEN Pfad, analytisch aus der Mittellinie:
   * flatten -> pro Punkt Normalen-Offset (±r) -> Bogen-/Flach-Kappen -> bereinigen.
   * Unabhängig von paperjs-offsets ungenauer Bézier-Offset-Mathematik, daher
   * keine Keile/Kerben an gekrümmten Enden.
   */
  function strokeOpenPoly(path, r, cap) {
    var pts = flattenPoints(path, r);
    if (pts.length < 2) return null;
    var n = pts.length;
    var left = [], right = [];
    for (var i = 0; i < n; i++) {
      var prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
      var dir = (prev && next) ? next.subtract(prev)
              : (next ? next.subtract(cur) : cur.subtract(prev));
      if (dir.length === 0) dir = new paper.Point(1, 0);
      dir = dir.normalize();
      var nrm = new paper.Point(-dir.y, dir.x);
      left.push(cur.add(nrm.multiply(r)));
      right.push(cur.subtract(nrm.multiply(r)));
    }
    var band = new paper.Path({ insert: false });
    band.addSegments(left.map(function (p) { return new paper.Segment(p); }));
    addCap(band, pts[n - 1], pts[n - 2], left[n - 1], right[n - 1], r, cap); // Ende
    right.reverse();
    band.addSegments(right.map(function (p) { return new paper.Segment(p); }));
    addCap(band, pts[0], pts[1], right[n - 1], left[0], r, cap);             // Anfang
    band.closed = true;
    var res = band.resolveCrossings ? band.resolveCrossings() : band;
    if (res !== band) band.remove();
    // KEIN simplify(): es fittet Béziers durch die dichten Cap-Bogen-Punkte und
    // verschleift die runden Enden zu Paddelformen. Das feine Polygon
    // (Facetten ≤ flatten-Toleranz) rendert ohnehin glatt.
    return res;
  }

  /** Geschlossener Pfad, zentriert: Ring = Offset(+r) minus Offset(-r). */
  function strokeClosedRing(path, r, join) {
    var outer = PaperOffset.offset(path, r, { join: join, insert: false });
    var inner = PaperOffset.offset(path, -r, { join: join, insert: false });
    var ring = outer.subtract(inner, { insert: false });
    outer.remove(); inner.remove();
    return ring;
  }

  /**
   * Wandelt einen Pfad (offen, geschlossen oder Compound) in eine gefüllte
   * Stroke-Kontur (Radius r = halbe Breite). Vereinigt Teilpfade.
   */
  function strokeToFill(item, r, join, cap) {
    var subs = (item instanceof paper.CompoundPath) ? item.children : [item];
    var result = null;
    for (var i = 0; i < subs.length; i++) {
      var part = subs[i].closed
        ? strokeClosedRing(subs[i], r, join)
        : strokeOpenPoly(subs[i], r, cap);
      if (!part || part.isEmpty()) { if (part) part.remove(); continue; }
      if (!result) {
        result = part;
      } else {
        var merged = result.unite(part, { insert: false });
        result.remove(); part.remove();
        result = merged;
      }
    }
    return result;
  }

  /**
   * @param {string} d        SVG-Pfaddaten des Quell-Shapes
   * @param {object} opts     { width, alignment: 'center'|'inner'|'outer', cap, join }
   * @returns {{ pathData: string, dx: number, dy: number, warning: string|null }}
   */
  function outlineStroke(d, opts) {
    var item = paper.PathItem.create(d);
    item.remove(); // nicht ins Projekt einfügen
    closeCoincident(item); // „fast geschlossene“ Pfade (Kreise ohne Z) schließen
    var w = Math.max(Number(opts.width) || 1, 0.01);
    var cap = (opts.cap === 'round' || opts.cap === 'circle-marker') ? 'round'
            : (opts.cap === 'square') ? 'square'
            : 'butt';
    var join = opts.join || 'miter';
    var closed = isClosed(item);
    var warning = null;
    var result = null;

    try {
      if (opts.alignment === 'inner' && closed) {
        var inner = PaperOffset.offset(item, -w, { join: join, insert: false });
        result = item.subtract(inner, { insert: false });
        inner.remove();
      } else if (opts.alignment === 'outer' && closed) {
        var outer = PaperOffset.offset(item, w, { join: join, insert: false });
        result = outer.subtract(item, { insert: false });
        outer.remove();
      }
    } catch (e) {
      warning = 'Innen/Außen-Offset fehlgeschlagen, nutze zentrierten Stroke';
      result = null;
    }

    if (!result) {
      if ((opts.alignment === 'inner' || opts.alignment === 'outer') && !closed && !warning) {
        warning = 'Offener Pfad: Ausrichtung wird als „zentriert“ behandelt';
      }
      result = strokeToFill(item, w / 2, join, cap);
    }
    if (!result || result.isEmpty()) {
      item.remove();
      throw new Error('Outline ergab leeren Pfad');
    }

    var ib = item.bounds;
    var rb = result.bounds;
    var out = {
      pathData: result.pathData,
      dx: rb.x - ib.x,
      dy: rb.y - ib.y,
      // Absolute Bounds der Outline (gleiche Koordinaten wie das Eingabe-d) –
      // damit das Plugin die extrahierte Form exakt positionieren kann.
      absX: rb.x,
      absY: rb.y,
      absW: rb.width,
      absH: rb.height,
      warning: warning,
    };
    result.remove();
    item.remove();
    return out;
  }

  global.OutlineCore = { outlineStroke: outlineStroke, isClosed: isClosed };
})(typeof window !== 'undefined' ? window : this);
