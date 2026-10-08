// Modello geometrico in mm e viste ortogonali (FRONT / TOP / RIGHT).
//
// Da una sola foto non si conosce la profondità dell'oggetto. Per questo
// l'utente sceglie il tipo di oggetto (che fissa l'ipotesi geometrica) e
// misura UNA sola dimensione visibile nella foto. Da quella quota si ricava
// la scala mm/px e tutte le altre dimensioni sono proporzionali ai pixel.
//
//   round  → solido di rivoluzione (torniti): la silhouette è il profilo.
//            TOP = cerchi concentrici, FRONT = RIGHT = profilo.
//   prism  → profilo nel piano frontale (X,Z) estruso lungo Y per D = p% · W.
//   plate  → profilo nel piano XY (foto dall'alto) estruso lungo Z per T = p% · W.
//
// Sistema di riferimento 3D (mm): X destra, Y profondità (fondo = Y crescente),
// Z verso l'alto. Viste: FRONT (X,Z), TOP (X,Y), RIGHT (Y,Z).

export const MODES = {
  round: {
    id: 'round',
    label: 'Rotazionale (tornito)',
    hint: 'Bicchiere, bottone, manopola, perno: la silhouette è il profilo di rotazione.',
  },
  prism: {
    id: 'prism',
    label: 'Profilo estruso (foto frontale)',
    hint: 'Staffa, profilo, pezzo con sezione costante in profondità.',
  },
  plate: {
    id: 'plate',
    label: "Piastra piatta (foto dall'alto)",
    hint: 'Guarnizione, lamiera, pezzo piano fotografato dall\'alto.',
  },
};

/** Quota in mm: un decimale, senza zeri inutili (es. 30, 17.5, 5.9). */
export function formatMm(v) {
  let s = (Math.round(v * 10) / 10).toFixed(1);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return s === '-0' ? '0' : s;
}

/** Semplificazione Ramer–Douglas–Peucker di una polilinea aperta. */
export function simplifyOpen(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function medianFilter(values, radius) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const win = [];
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      win.push(values[j]);
    }
    win.sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}

/** Valori unici di una coordinata nei vertici con cambio di direzione (spigoli). */
function cornerCoords(poly, axis) {
  const n = poly.length;
  const vals = [];
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n];
    const c = poly[i];
    const q = poly[(i + 1) % n];
    const ax = c[0] - p[0];
    const ay = c[1] - p[1];
    const bx = q[0] - c[0];
    const by = q[1] - c[1];
    const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    if (turn > (25 * Math.PI) / 180) vals.push(c[axis]);
  }
  vals.sort((a, b) => a - b);
  const out = [];
  for (const v of vals) if (!out.length || Math.abs(v - out[out.length - 1]) > 0.05) out.push(v);
  return out;
}

/** Gradini: tratti del profilo a raggio costante e lunghezza significativa (non le transizioni). */
export function plateausOf(prof, H, Rmax) {
  const minLen = Math.max(1.0, 0.02 * H);
  const rTol = Math.max(0.3, 0.012 * Rmax);
  const segs = [];
  for (let i = 0; i + 1 < prof.length; i++) {
    const [r0, z0] = prof[i];
    const [r1, z1] = prof[i + 1];
    if (Math.abs(r1 - r0) <= rTol && Math.abs(z1 - z0) >= minLen) {
      segs.push({ r: (r0 + r1) / 2, z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
    }
  }
  // Unisce tratti consecutivi dello stesso gradino (il DP può spezzarli).
  const out = [];
  for (const sg of segs) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.r - sg.r) <= rTol && sg.z0 - last.z1 <= minLen) {
      last.z1 = Math.max(last.z1, sg.z1);
      last.r = (last.r + sg.r) / 2;
    } else {
      out.push({ ...sg });
    }
  }
  return out.filter((p) => p.z1 - p.z0 >= minLen);
}

/**
 * Livelli Z ordinati: valori a meno di `tol` l'uno dall'altro diventano un solo livello
 * (la media). Gli estremi 0 e H restano esatti.
 */
export function stepLevels(values, H, tol) {
  const sorted = values.slice().sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g[g.length - 1] < tol) g.push(v);
    else groups.push([v]);
  }
  const levels = groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
  levels[0] = 0;
  levels[levels.length - 1] = H;
  return levels;
}

/** Mantiene un solo elemento per ogni valore distinto di `key` (tolleranza 0.5 mm). */
function uniqueBy(arr, key) {
  const out = [];
  for (const h of arr) if (!out.some((o) => Math.abs(o[key] - h[key]) < 0.5)) out.push(h);
  return out;
}

function rectPts(x0, y0, x1, y1) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Raggio massimo del profilo (polilinea bottom→top) alla quota z; sui gradini verticali vale il maggiore. */
export function profileRadiusAt(prof, z) {
  let best = 0;
  for (let i = 0; i + 1 < prof.length; i++) {
    const [r0, z0] = prof[i];
    const [r1, z1] = prof[i + 1];
    const lo = Math.min(z0, z1);
    const hi = Math.max(z0, z1);
    if (z < lo - 1e-9 || z > hi + 1e-9) continue;
    if (hi - lo < 1e-9) best = Math.max(best, r0, r1);
    else best = Math.max(best, r0 + ((r1 - r0) * (z - z0)) / (z1 - z0));
  }
  return best;
}

function buildRound(f, s) {
  const { sil, width, bbox } = f;
  const rows = [];
  for (let y = bbox.y0; y <= bbox.y1; y++) {
    const base = y * width;
    let xl = -1;
    for (let x = bbox.x0; x <= bbox.x1; x++) {
      if (sil[base + x]) {
        xl = x;
        break;
      }
    }
    if (xl < 0) continue;
    let xr = bbox.x1;
    while (xr > xl && !sil[base + xr]) xr--;
    rows.push({ y, r: (xr - xl + 1) / 2 });
  }
  if (rows.length < 3) throw new Error('Profilo troppo piccolo per essere ricostruito.');

  const rs = medianFilter(
    rows.map((r) => r.r),
    2,
  );
  const H = (bbox.y1 + 1 - bbox.y0) * s;
  // Campioni dal basso verso l'alto, in mm: (raggio, quota Z).
  const samples = rows.map((r, i) => [rs[i] * s, (bbox.y1 + 0.5 - r.y) * s]).reverse();
  const raw = [[samples[0][0], 0], ...samples, [samples[samples.length - 1][0], H]];
  const prof = simplifyOpen(raw, 0.8 * s);
  const Rmax = Math.max(...prof.map((p) => p[0]));
  const rTol = Math.max(0.3, 0.012 * Rmax);

  // Profilo chiuso: lato destro (X = +r) dal basso in alto, poi lato sinistro.
  const polyFront = [
    ...prof.map(([r, z]) => [r, z]),
    ...prof
      .slice()
      .reverse()
      .map(([r, z]) => [-r, z]),
  ];

  const plateaus = plateausOf(prof, H, Rmax);
  const radii = [Rmax, ...plateaus.map((p) => p.r)].sort((a, b) => b - a);
  const circleR = [];
  for (const r of radii) if (!circleR.some((c) => Math.abs(c - r) <= rTol)) circleR.push(r);

  // Livelli Z dei gradini → quote a catena (lunghezza di ogni gradino) sul lato sinistro.
  // Bordi vicini (zona di transizione fra due gradini) si fondono in un unico livello.
  const zs = stepLevels([0, H, ...plateaus.flatMap((p) => [p.z0, p.z1])], H, Math.max(1.0, 0.02 * H));
  // Raggio esterno del profilo al livello z: il gradino che termina a quella quota,
  // altrimenti il profilo stesso (tratti non a gradino, es. raccordi).
  const tolE = 2 * Math.max(1.0, 0.02 * H);
  const edgeR = (z) => {
    let r = 0;
    for (const p of plateaus) if (Math.abs(p.z0 - z) <= tolE || Math.abs(p.z1 - z) <= tolE) r = Math.max(r, p.r);
    return r || profileRadiusAt(prof, z);
  };
  const chain = [];
  for (let i = 0; i + 1 < zs.length; i++) {
    const len = zs[i + 1] - zs[i];
    if (len < 1) continue;
    chain.push({
      dir: 'v',
      p1: zs[i],
      p2: zs[i + 1],
      a1: -edgeR(zs[i]),
      a2: -edgeR(zs[i + 1]),
      side: 'left',
      level: 0,
      text: formatMm(len),
    });
  }
  const dimsFront = [
    { dir: 'h', p1: -Rmax, p2: Rmax, side: 'top', level: 0, text: 'Ø ' + formatMm(2 * Rmax) },
    ...chain,
    { dir: 'v', p1: 0, p2: H, side: 'left', level: chain.length ? 1 : 0, text: formatMm(H) },
  ];

  const ext = { X: [-Rmax, Rmax], Y: [-Rmax, Rmax], Z: [0, H] };
  const views = {
    FRONT: {
      axes: ['X', 'Z'],
      polys: [{ pts: polyFront, closed: true }],
      circles: [],
      lines: [{ p: [0, -3], q: [0, H + 3], style: 'center' }],
      // Ø di ciascun gradino, con freccia sul bordo esterno a metà altezza.
      labels: plateaus.map((p) => ({ at: [p.r, (p.z0 + p.z1) / 2], dx: 8, dy: 0, text: 'Ø ' + formatMm(2 * p.r) })),
      dims: dimsFront,
    },
    TOP: {
      axes: ['X', 'Y'],
      polys: [],
      circles: circleR.map((r) => ({ c: [0, 0], r })),
      lines: [
        { p: [-Rmax - 3, 0], q: [Rmax + 3, 0], style: 'center' },
        { p: [0, -Rmax - 3], q: [0, Rmax + 3], style: 'center' },
      ],
      labels: [],
      dims: [],
    },
    RIGHT: {
      axes: ['Y', 'Z'],
      polys: [{ pts: polyFront, closed: true }],
      circles: [],
      lines: [{ p: [0, -3], q: [0, H + 3], style: 'center' }],
      labels: [],
      dims: [],
    },
  };

  const summary = {
    mode: 'round',
    diametro: 2 * Rmax,
    altezza: H,
    gradini: plateaus.map((p) => ({ d: 2 * p.r, z0: p.z0, z1: p.z1 })),
    fori: [],
  };
  return { mode: 'round', ext, views, summary };
}

function buildExtruded(f, s, mode, depthPct) {
  const { bbox, outline, holes } = f;
  const x0 = bbox.x0;
  const y1 = bbox.y1;
  // Coordinate continue (mm) con origine in basso a sinistra della silhouette.
  const toMm = (x, y) => [(x + 0.5 - x0) * s, (y1 + 0.5 - y) * s];
  const W = (bbox.x1 + 1 - x0) * s; // larghezza in X
  const V = (y1 + 1 - bbox.y0) * s; // altezza del profilo (Z per prism, Y per plate)
  const T = (depthPct / 100) * W; // profondità (prism) o spessore (plate)

  const poly = outline.map(([x, y]) => toMm(x, y));
  const holeList = holes
    .map((h) => {
      if (h.type === 'circle') {
        const [u, v] = toMm(h.cx, h.cy);
        return { type: 'circle', u, v, r: (h.d * s) / 2, d: h.d * s };
      }
      const pts = h.pts.map(([x, y]) => toMm(x, y));
      const us = pts.map((p) => p[0]);
      const vs = pts.map((p) => p[1]);
      const umin = Math.min(...us);
      const umax = Math.max(...us);
      const vmin = Math.min(...vs);
      const vmax = Math.max(...vs);
      const d = Math.max(umax - umin, vmax - vmin);
      return { type: 'poly', pts, u: (umin + umax) / 2, v: (vmin + vmax) / 2, umin, umax, vmin, vmax, r: d / 2, d };
    })
    .sort((a, b) => b.v - a.v || a.u - b.u);

  // Spigoli interni del contorno: i bordi esterni sono già disegnati dal contorno.
  const innerCoords = (vals, hi) => vals.filter((v) => v > 0.05 && v < hi - 0.05);
  const uC = innerCoords(cornerCoords(poly, 0), W);
  const vC = innerCoords(cornerCoords(poly, 1), V);

  // Fori passanti lungo l'estrusione: linee nascoste (tratteggiate) nelle viste
  // perpendicolari. `axis` è 'u' o 'v' (coordinata del foro nella vista),
  // `vertical` indica se l'estrusione è lungo l'asse verticale della vista.
  const addHiddenHoles = (view, axis, L, vertical) => {
    for (const h of holeList) {
      const edges = h.type === 'circle' ? [h[axis] - h.r, h[axis] + h.r] : [h[axis + 'min'], h[axis + 'max']];
      for (const e of edges) {
        view.lines.push(vertical ? { p: [e, 0], q: [e, L], style: 'hidden' } : { p: [0, e], q: [L, e], style: 'hidden' });
      }
      if (h.type === 'circle') {
        const c = h[axis];
        view.lines.push(vertical ? { p: [c, -3], q: [c, L + 3], style: 'center' } : { p: [-3, c], q: [L + 3, c], style: 'center' });
      }
    }
  };

  // Vista che contiene il contorno con i fori. Le quote di posizione partono dall'origine:
  // i livelli crescono con la coordinata, così le linee di estensione non si incrociano.
  // L'estensione segue la mezzeria del foro (tratto-punto), come da UNI EN ISO 129.
  // hOrder: fori ordinati dal bordo di quota orizzontale verso l'interno.
  const annotateProfile = (view, hSide, hOrder) => {
    view.circles = holeList.filter((h) => h.type === 'circle').map((h) => ({ c: [h.u, h.v], r: h.r }));
    for (const h of holeList.filter((x) => x.type === 'poly')) view.polys.push({ pts: h.pts, closed: true });
    holeList.slice(0, 4).forEach((h, i) => {
      if (h.type === 'circle') {
        view.lines.push({ p: [h.u - h.r - 2, h.v], q: [h.u + h.r + 2, h.v], style: 'center' });
        view.lines.push({ p: [h.u, h.v - h.r - 2], q: [h.u, h.v + h.r + 2], style: 'center' });
      }
      view.labels.push({
        at: [h.u + h.r * Math.SQRT1_2, h.v + h.r * Math.SQRT1_2],
        dx: 7,
        dy: -7 - 2 * i,
        text: h.type === 'circle' ? 'Ø ' + formatMm(h.d) : `asola ${formatMm(h.umax - h.umin)} × ${formatMm(h.vmax - h.vmin)}`,
      });
    });
    const xHoles = uniqueBy(hOrder, 'u').slice(0, 4).sort((a, b) => a.u - b.u);
    xHoles.forEach((h, i) => {
      view.dims.push({ dir: 'h', p1: 0, p2: h.u, a2: h.v, ext: 'center', side: hSide, level: i, text: formatMm(h.u) });
    });
    const yHoles = uniqueBy(holeList.slice().sort((a, b) => a.u - b.u), 'v')
      .slice(0, 4)
      .sort((a, b) => a.v - b.v);
    yHoles.forEach((h, i) => {
      view.dims.push({ dir: 'v', p1: 0, p2: h.v, a2: h.u, ext: 'center', side: 'left', level: i, text: formatMm(h.v) });
    });
    return yHoles.length;
  };

  const views = {};
  let ext;
  if (mode === 'prism') {
    // Profilo in (X,Z) estruso lungo Y da 0 a T.
    ext = { X: [0, W], Y: [0, T], Z: [0, V] };
    views.FRONT = {
      axes: ['X', 'Z'],
      polys: [{ pts: poly, closed: true }],
      circles: [],
      lines: [],
      labels: [],
      dims: [{ dir: 'h', p1: 0, p2: W, side: 'top', level: 0, text: formatMm(W) }],
    };
    // Fori nel profilo: quote dal bordo inferiore (sotto) e dal bordo sinistro (a sinistra).
    const nLeft = annotateProfile(views.FRONT, 'bottom', holeList.slice().sort((a, b) => a.v - b.v));
    views.FRONT.dims.push({ dir: 'v', p1: 0, p2: V, side: 'left', level: nLeft, text: formatMm(V) });

    views.TOP = {
      axes: ['X', 'Y'],
      polys: [{ pts: rectPts(0, 0, W, T), closed: true }],
      circles: [],
      lines: uC.map((u) => ({ p: [u, 0], q: [u, T], style: 'visible' })),
      labels: [],
      dims: [{ dir: 'v', p1: 0, p2: T, side: 'right', level: 0, text: formatMm(T) }],
    };
    addHiddenHoles(views.TOP, 'u', T, true);

    views.RIGHT = {
      axes: ['Y', 'Z'],
      polys: [{ pts: rectPts(0, 0, T, V), closed: true }],
      circles: [],
      lines: vC.map((v) => ({ p: [0, v], q: [T, v], style: 'visible' })),
      labels: [],
      dims: [],
    };
    addHiddenHoles(views.RIGHT, 'v', T, false);
  } else {
    // mode === 'plate': profilo in (X,Y) (foto dall'alto), estruso lungo Z da 0 a T.
    ext = { X: [0, W], Y: [0, V], Z: [0, T] };
    views.TOP = {
      axes: ['X', 'Y'],
      polys: [{ pts: poly, closed: true }],
      circles: [],
      lines: [],
      labels: [],
      dims: [{ dir: 'v', p1: 0, p2: V, side: 'right', level: 0, text: formatMm(V) }],
    };
    // Fori nel profilo: quote dal bordo superiore (sopra) e dal bordo sinistro (a sinistra).
    annotateProfile(views.TOP, 'top', holeList.slice().sort((a, b) => b.v - a.v));

    views.FRONT = {
      axes: ['X', 'Z'],
      polys: [{ pts: rectPts(0, 0, W, T), closed: true }],
      circles: [],
      lines: uC.map((u) => ({ p: [u, 0], q: [u, T], style: 'visible' })),
      labels: [],
      dims: [
        { dir: 'h', p1: 0, p2: W, side: 'top', level: 0, text: formatMm(W) },
        { dir: 'v', p1: 0, p2: T, side: 'left', level: 0, text: formatMm(T) },
      ],
    };
    addHiddenHoles(views.FRONT, 'u', T, true);

    views.RIGHT = {
      axes: ['Y', 'Z'],
      polys: [{ pts: rectPts(0, 0, V, T), closed: true }],
      circles: [],
      lines: vC.map((v) => ({ p: [v, 0], q: [v, T], style: 'visible' })),
      labels: [],
      dims: [],
    };
    addHiddenHoles(views.RIGHT, 'v', T, true);
  }

  const summary =
    mode === 'prism'
      ? { mode, larghezza: W, altezza: V, profondita: T }
      : { mode, larghezza: W, lunghezza: V, spessore: T };
  summary.fori = holeList.map((h) => ({ tipo: h.type, d: h.d, u: h.u, v: h.v }));
  summary.gradini = [];
  return { mode, ext, views, summary, depthMm: T };
}

/** Punto dentro un poligono (ray casting). */
export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Gate sulle feature della foto: contorno semplice, area positiva, fori dentro il contorno. */
export function validateFeatures(f) {
  const issues = [];
  if (!f || !Array.isArray(f.outline) || f.outline.length < 3) issues.push('contorno non valido');
  else {
    let area2 = 0;
    for (let i = 0; i < f.outline.length; i++) {
      const [x0, y0] = f.outline[i];
      const [x1, y1] = f.outline[(i + 1) % f.outline.length];
      area2 += x0 * y1 - x1 * y0;
    }
    if (!(Math.abs(area2) > 0)) issues.push('area nulla');
    for (const h of f.holes || []) {
      if (!pointInPoly(h.cx, h.cy, f.outline)) issues.push('foro fuori dal contorno');
      if (h.type === 'circle' && !(h.d > 0)) issues.push('diametro di foro non valido');
    }
  }
  return issues;
}

/** Gate sul disegno: valori finiti, quote presenti, geometria con estensioni positive. */
export function validateDrawing(d) {
  const issues = [];
  for (const [a, b] of Object.values(d.ext)) if (!(Number.isFinite(a) && Number.isFinite(b) && b > a)) issues.push('estensioni non valide');
  for (const [k, v] of Object.entries(d.summary)) if (typeof v === 'number' && !Number.isFinite(v)) issues.push(`misura non finita (${k})`);
  for (const view of Object.values(d.views)) {
    for (const dim of view.dims) if (typeof dim.text !== 'string' || dim.text.length === 0) issues.push('quota senza testo');
    for (const p of view.polys) for (const [x, y] of p.pts) if (!(Number.isFinite(x) && Number.isFinite(y))) issues.push('vertice non finito');
  }
  return [...new Set(issues)];
}

const modelError = (issues) =>
  `Modello non valido (${issues.join('; ')}). Prova a ritagliare l’area sull’oggetto o a usare un’altra foto.`;

/**
 * Costruisce il disegno (mm) a partire dalle feature della foto.
 * @param {object} features  output di segmentPhoto()
 * @param {{mode:'round'|'prism'|'plate', refAxis:'h'|'v', refMm:number, depthPct:number}} opts
 *        refAxis: 'h' = la quota è in orizzontale nella foto, 'v' = in verticale.
 */
export function buildDrawing(features, opts) {
  const { mode, refAxis, refMm, depthPct = 50 } = opts;
  if (!MODES[mode]) throw new Error(`Tipo di oggetto non valido: ${mode}`);
  if (!(refMm > 0)) throw new Error('La quota di riferimento deve essere maggiore di zero.');
  if (refAxis !== 'h' && refAxis !== 'v') throw new Error('Asse della quota non valido.');
  if (!(depthPct > 0 && depthPct <= 500)) throw new Error('Profondità non valida (1–500 %).');
  const featureIssues = validateFeatures(features);
  if (featureIssues.length) throw new Error(modelError(featureIssues));

  const { bbox } = features;
  const pxRef = refAxis === 'h' ? bbox.x1 + 1 - bbox.x0 : bbox.y1 + 1 - bbox.y0;
  const s = refMm / pxRef;
  const drawing = mode === 'round' ? buildRound(features, s) : buildExtruded(features, s, mode, depthPct);

  drawing.refAxis = refAxis;
  drawing.refMm = refMm;
  drawing.mmPerPx = s;
  drawing.depthPct = depthPct;
  drawing.summary.refAxis = refAxis;
  drawing.summary.refMm = refMm;
  drawing.summary.mmPerPx = s;
  const issues = validateDrawing(drawing);
  if (issues.length) throw new Error(modelError(issues));
  return drawing;
}
