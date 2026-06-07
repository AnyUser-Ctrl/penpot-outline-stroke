/**
 * Outline Stroke – Penpot Plugin (Sandbox-Teil)
 * Läuft im Penpot-Plugin-Kontext. Die Geometrie (Path-Offsetting)
 * berechnet die UI (index.html) mit paper.js + paperjs-offset.
 *
 * Ablauf:
 *   UI  →{type:'outline', options}→  plugin
 *   plugin sammelt Selektion         →{type:'compute', shapes}→ UI
 *   UI rechnet Outline               →{type:'apply', results}→  plugin
 *   plugin erzeugt Shapes            →{type:'done'|'status'}→   UI
 */

penpot.ui.open('Outline Stroke', `/index.html?theme=${penpot.theme}`, {
  width: 320,
  height: 440,
});

// Theme-Wechsel an die UI weiterreichen
try {
  penpot.on('themechange', (theme) => {
    penpot.ui.sendMessage({ source: 'penpot', type: 'themechange', theme });
  });
} catch (e) {
  /* ältere API – ignorieren */
}

/** Merkt sich Shapes zwischen 'compute' und 'apply' (id -> shape). */
const pending = new Map();
let pendingKeepOriginal = true;
let pendingPlacement = 'beside'; // 'beside' | 'inplace'

function send(msg) {
  penpot.ui.sendMessage(Object.assign({ source: 'outline-stroke' }, msg));
}

/**
 * Baut Pfaddaten (d) für geschlossene Basis-Shapes ohne eigenes d.
 * penpot.flatten() existiert in der Plugin-API NICHT – daher konstruieren
 * wir Ellipse/Rechteck direkt aus ihrer Geometrie (achsenparallel).
 */
function shapeToPathData(shape) {
  const x = shape.x, y = shape.y, w = shape.width, h = shape.height;
  if (typeof x !== 'number' || typeof y !== 'number' ||
      typeof w !== 'number' || typeof h !== 'number') {
    return null;
  }
  if (shape.type === 'ellipse') {
    const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
    return 'M' + (cx - rx) + ',' + cy +
           'A' + rx + ',' + ry + ' 0 1 0 ' + (cx + rx) + ',' + cy +
           'A' + rx + ',' + ry + ' 0 1 0 ' + (cx - rx) + ',' + cy + 'Z';
  }
  if (shape.type === 'rectangle') {
    let r = shape.borderRadius || 0;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r > 0) {
      return 'M' + (x + r) + ',' + y +
             'L' + (x + w - r) + ',' + y +
             'A' + r + ',' + r + ' 0 0 1 ' + (x + w) + ',' + (y + r) +
             'L' + (x + w) + ',' + (y + h - r) +
             'A' + r + ',' + r + ' 0 0 1 ' + (x + w - r) + ',' + (y + h) +
             'L' + (x + r) + ',' + (y + h) +
             'A' + r + ',' + r + ' 0 0 1 ' + x + ',' + (y + h - r) +
             'L' + x + ',' + (y + r) +
             'A' + r + ',' + r + ' 0 0 1 ' + (x + r) + ',' + y + 'Z';
    }
    return 'M' + x + ',' + y +
           'L' + (x + w) + ',' + y +
           'L' + (x + w) + ',' + (y + h) +
           'L' + x + ',' + (y + h) + 'Z';
  }
  return null;
}

/**
 * Verarbeitet ein Shape rekursiv: Pfad/Ellipse/Rechteck -> sammeln,
 * Gruppe/Board (Container ohne eigenes d) -> in die Kinder absteigen.
 */
function collectShape(shape, shapes, warnings, depth) {
  let d = (typeof shape.d === 'string' && shape.d.length) ? shape.d : null;

  // Rechtecke/Ellipsen haben kein d -> aus Geometrie konstruieren.
  if (!d) {
    const built = shapeToPathData(shape);
    if (built) {
      d = built;
      if (shape.rotation) {
        warnings.push('„' + shape.name + '“: Rotation wird ignoriert (Outline achsenparallel)');
      }
    }
  }

  // Container (Gruppe/Board) ohne eigenes d -> rekursiv in die Kinder.
  if (!d) {
    if (shape.children && shape.children.length && depth < 8) {
      for (const child of shape.children) {
        collectShape(child, shapes, warnings, depth + 1);
      }
      return;
    }
    warnings.push('„' + shape.name + '“: kein Pfad – übersprungen');
    return;
  }

  const strokes = shape.strokes || [];
  if (strokes.length === 0) {
    warnings.push('„' + shape.name + '“: hat keinen Stroke – übersprungen');
    return;
  }
  if (strokes.length > 1) {
    warnings.push('„' + shape.name + '“: hat ' + strokes.length + ' Strokes, nur der erste wird umgewandelt');
  }

  const st = strokes[0];
  let color = st.strokeColor;
  const opacity = typeof st.strokeOpacity === 'number' ? st.strokeOpacity : 1;

  if (!color && st.strokeColorGradient) {
    const stops = st.strokeColorGradient.stops || [];
    color = (stops[0] && stops[0].color) || '#000000';
    warnings.push('„' + shape.name + '“: Gradient-Stroke → Füllung wird Volltonfarbe (' + color + ')');
  }
  if (!color) color = '#000000';

  if (st.strokeStyle && st.strokeStyle !== 'solid' && st.strokeStyle !== 'none') {
    warnings.push('„' + shape.name + '“: Stil „' + st.strokeStyle + '“ wird als durchgezogen behandelt');
  }
  // Cap-Stil bestimmt die UI (Dropdown). Die Penpot-API meldet den Linecap
  // importierter SVGs unzuverlässig als „none“, daher hier bewusst nicht ausgewertet.

  pending.set(shape.id, shape);
  shapes.push({
    id: shape.id,
    name: shape.name,
    d: d,
    x: shape.x,
    y: shape.y,
    width: typeof st.strokeWidth === 'number' ? st.strokeWidth : 1,
    alignment: st.strokeAlignment || 'center',
    color: color,
    opacity: opacity,
  });
}

function collectSelection() {
  const shapes = [];
  const warnings = [];
  pending.clear();
  for (const original of (penpot.selection || [])) {
    collectShape(original, shapes, warnings, 0);
  }
  return { shapes, warnings };
}

function applyResults(results, keepOriginal, placement) {
  let undoBlock = null;
  try {
    undoBlock = penpot.history.undoBlockBegin();
  } catch (e) {
    /* optional */
  }

  const created = [];
  const warnings = [];

  // Versatz, damit die Outline NEBEN dem Original erscheint (nur wenn das
  // Original behalten wird): Breite der gesamten Outline-Sammlung + Abstand.
  let deltaX = 0;
  if (keepOriginal && placement !== 'inplace' && results.length) {
    let mnX = Infinity, mxX = -Infinity;
    for (const r of results) {
      if (typeof r.absX === 'number' && typeof r.absW === 'number') {
        mnX = Math.min(mnX, r.absX);
        mxX = Math.max(mxX, r.absX + r.absW);
      }
    }
    if (isFinite(mnX)) deltaX = (mxX - mnX) + 40;
  }

  // Die UI liefert pro Farbe EIN bereits vereintes Ergebnis (alle Strokes der
  // Auswahl zu einer Form gemergt) -> es entsteht genau ein Shape je Farbe.
  for (const r of results) {
    try {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg">' +
        `<path d="${r.pathData}" fill="${r.color}" fill-opacity="${r.opacity}" stroke="none"/>` +
        '</svg>';
      const wrapper = penpot.createShapeFromSvg(svg);
      if (!wrapper) {
        warnings.push('Outline konnte nicht erzeugt werden');
        continue;
      }

      // createShapeFromSvg erzeugt eine Gruppe mit einem „base-background“-
      // Rechteck (der unerwünschte große Frame) PLUS dem Pfad. Pfad herauslösen,
      // Hintergrund entfernen.
      let shape = wrapper;
      if (wrapper.children && wrapper.children.length) {
        const kids = wrapper.children.slice();
        let pathShape = null;
        for (const c of kids) { if (!pathShape && c.type === 'path') pathShape = c; }
        try { penpot.ungroup(wrapper); } catch (e) { /* Fallback: Gruppe behalten */ }
        for (const c of kids) {
          if (c !== pathShape) { try { c.remove(); } catch (e) {} }
        }
        if (pathShape) shape = pathShape;
      }

      // Exakt an die absoluten Outline-Bounds setzen (+ Versatz neben Original).
      if (typeof r.absX === 'number' && typeof r.absY === 'number') {
        shape.x = r.absX + deltaX;
        shape.y = r.absY;
      }
      // Fill explizit setzen – beim Herauslösen aus der SVG-Gruppe geht der
      // ursprüngliche Fill sonst verloren (Shape bliebe unsichtbar).
      try {
        shape.fills = [{ fillColor: r.color, fillOpacity: (typeof r.opacity === 'number' ? r.opacity : 1) }];
      } catch (e) { /* Fill nicht setzbar – ignorieren */ }
      shape.name = 'Outline';
      created.push(shape);
    } catch (e) {
      warnings.push('Outline: ' + (e && e.message ? e.message : 'Fehler beim Erzeugen'));
    }
  }

  // Originale entfernen, wenn nicht behalten (alle gesammelten Leaf-Shapes).
  if (!keepOriginal) {
    pending.forEach(function (orig) {
      try { orig.remove(); } catch (e) {}
    });
  }

  // Mehrere Farben -> als Gruppe bündeln; eine Farbe -> ein einzelnes Shape.
  let selection = created;
  if (created.length > 1) {
    try {
      const g = penpot.group(created);
      if (g) {
        g.name = 'Outline';
        selection = [g];
      }
    } catch (e) {
      warnings.push('Outlines konnten nicht gruppiert werden');
    }
  }

  if (undoBlock) {
    try {
      penpot.history.undoBlockFinish(undoBlock);
    } catch (e) {
      /* optional */
    }
  }

  pending.clear();
  try {
    penpot.selection = selection;
  } catch (e) {
    /* nicht kritisch */
  }
  return { count: created.length, warnings };
}

penpot.ui.onMessage((msg) => {
  if (!msg || msg.source === 'penpot') return;

  try {
    if (msg.type === 'outline') {
      pendingKeepOriginal = msg.keepOriginal !== false;
      pendingPlacement = msg.placement === 'inplace' ? 'inplace' : 'beside';
      const { shapes, warnings } = collectSelection();
      if (shapes.length === 0) {
        send({
          type: 'status',
          level: 'error',
          message: 'Nichts zu tun: Wähle mindestens ein Shape mit Stroke aus.',
          warnings,
        });
        return;
      }
      send({ type: 'compute', shapes, warnings, join: msg.join || 'miter' });
      return;
    }

    if (msg.type === 'apply') {
      const { count, warnings } = applyResults(msg.results || [], pendingKeepOriginal, pendingPlacement);
      send({
        type: 'done',
        count,
        warnings: (msg.warnings || []).concat(warnings),
      });
      return;
    }
  } catch (e) {
    // Fängt sonst unbehandelte Sandbox-Fehler ab (statt generischem Penpot-Toast)
    // und zeigt die echte Meldung direkt im Plugin-Panel.
    const detail = (e && e.message) ? e.message : String(e);
    send({
      type: 'status',
      level: 'error',
      message: 'Plugin-Fehler (' + (msg.type || '?') + '): ' + detail,
    });
  }
});
