// Tavola tecnica A4 orizzontale in SVG: viste ortogonali, quote e cartiglio.
// Tutte le misure dell'SVG sono in mm (viewBox 297 × 210).
import { formatMm } from './geometry.js';

export const PAGE = { w: 297, h: 210 };
const FRAME = { x0: 10, y0: 10, x1: 287, y1: 200 };
const AREA = { x0: 16, y0: 16, x1: 281, y1: 154 }; // zona disponibile per le viste
const TB = { x0: 122, y0: 160, x1: 287, y1: 200 }; // cartiglio
const RATIOS = [1 / 50, 1 / 20, 1 / 10, 1 / 5, 1 / 2, 1, 2, 5, 10]; // scale UNI 3973
const GAP_V = 20; // fra TOP e FRONT (contiene le quote orizzontali della FRONT)
const GAP_H = 24; // fra FRONT e RIGHT (contiene le etichette Ø dei gradini)
const FONT = 3.2;
const LW = { visible: 0.35, hidden: 0.25, center: 0.18, dim: 0.18, ext: 0.13 };
const DASH = { hidden: '2.4 1.4', center: '8 1.2 1.6 1.2' };
const ARROW = { len: 2.6, half: 0.9 };

const f = (v) => (Math.round(v * 1000) / 1000).toString();
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Distanza della quota dal contorno della vista (mm sul foglio). */
const offsetOf = (level) => 6 + 6 * level;

/** Margini del foglio necessari per quote ed etichette (mm sul foglio). */
function margins(drawing) {
  const maxLevel = { left: -1, right: -1, top: -1, bottom: -1 };
  let labelsRight = false;
  for (const name of ['FRONT', 'TOP', 'RIGHT']) {
    const view = drawing.views[name];
    for (const d of view.dims) maxLevel[d.side] = Math.max(maxLevel[d.side], d.level ?? 0);
    if (name === 'TOP' && view.labels.length) labelsRight = true;
  }
  // Le quote di FRONT in alto stanno nella gap verticale; non servono margini extra.
  const side = (s, extra) => (maxLevel[s] >= 0 ? offsetOf(maxLevel[s]) + 6 : extra);
  return {
    left: side('left', 4),
    right: Math.max(side('right', 4), labelsRight ? 24 : 4),
    top: side('top', 4) + (drawing.views.TOP.labels.length ? 6 : 0),
    bottom: Math.max(side('bottom', 4), 10), // spazio per il nome della vista
  };
}

/** Sceglie la scala standard più grande che fa stare le tre viste nell'area del foglio. */
export function chooseLayout(drawing) {
  const { ext } = drawing;
  const Wf = ext.X[1] - ext.X[0]; // FRONT: larghezza
  const Hf = ext.Z[1] - ext.Z[0]; // FRONT: altezza
  const Dt = ext.Y[1] - ext.Y[0]; // TOP: altezza = profondità
  const Wr = Dt; // RIGHT: larghezza = profondità
  const m = margins(drawing);
  const availW = AREA.x1 - AREA.x0;
  const availH = AREA.y1 - AREA.y0;
  let k = null;
  for (const r of RATIOS.slice().reverse()) {
    const needW = m.left + r * Wf + GAP_H + r * Wr + m.right;
    const needH = m.top + r * Dt + GAP_V + r * Hf + m.bottom;
    if (needW <= availW && needH <= availH) {
      k = r;
      break;
    }
  }
  const fits = k !== null;
  if (!fits) k = RATIOS[0];
  const needW = m.left + k * Wf + GAP_H + k * Wr + m.right;
  const needH = m.top + k * Dt + GAP_V + k * Hf + m.bottom;
  const x0 = AREA.x0 + (availW - needW) / 2 + m.left; // origine x del FRONT
  const yTopTop = AREA.y0 + (availH - needH) / 2 + m.top; // bordo superiore della TOP
  const yTopBottom = yTopTop + k * Dt; // bordo inferiore della TOP
  const yFrontBottom = yTopBottom + GAP_V + k * Hf; // bordo inferiore della FRONT/RIGHT
  const xRightLeft = x0 + k * Wf + GAP_H;
  return {
    k,
    fits,
    ratioLabel: k >= 1 ? `${formatMm(k)}:1` : `1:${formatMm(1 / k)}`,
    origin: {
      FRONT: { x: x0, y: yFrontBottom },
      TOP: { x: x0, y: yTopBottom },
      RIGHT: { x: xRightLeft, y: yFrontBottom },
    },
  };
}

function mapper(drawing, layout) {
  const { ext } = drawing;
  const k = layout.k;
  const o = layout.origin;
  return {
    FRONT: (h, v) => [o.FRONT.x + (h - ext.X[0]) * k, o.FRONT.y - (v - ext.Z[0]) * k],
    TOP: (h, v) => [o.TOP.x + (h - ext.X[0]) * k, o.TOP.y - (v - ext.Y[0]) * k],
    RIGHT: (h, v) => [o.RIGHT.x + (h - ext.Y[0]) * k, o.RIGHT.y - (v - ext.Z[0]) * k],
  };
}

function lineEl(x1, y1, x2, y2, w, dash) {
  return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="#000" stroke-width="${w}"${
    dash ? ` stroke-dasharray="${dash}"` : ''
  } fill="none"/>`;
}

function textEl(x, y, str, { size = FONT, anchor = 'middle', rotate = null, weight = null, fill = '#000' } = {}) {
  const tr = rotate !== null ? ` transform="rotate(${rotate} ${f(x)} ${f(y)})"` : '';
  return `<text x="${f(x)}" y="${f(y)}" font-size="${size}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" fill="${fill}"${
    weight ? ` font-weight="${weight}"` : ''
  }${tr}>${esc(str)}</text>`;
}

/**
 * Quota lineare con frecce, linee di estensione e testo interrotto.
 * Se il segmento è troppo corto per contenere il testo fra le frecce, il testo va fuori
 * dalla quota (UNI EN ISO 129). dim.ext === 'center': estensione a tratto-punto (mezzeria foro).
 */
function dimEl(drawing, view, dim, map, box) {
  const ha = drawing.views[view].axes[0];
  const va = drawing.views[view].axes[1];
  const ext = drawing.ext;
  const off = offsetOf(dim.level ?? 0);
  const out = [];
  const extLine = (x1, y1, x2, y2, center) =>
    center ? lineEl(x1, y1, x2, y2, LW.center, DASH.center) : lineEl(x1, y1, x2, y2, LW.ext);
  const arrow = (x, y, dirX, dirY) => {
    // Punta in (x, y), corpo nella direzione (dirX, dirY).
    const px = -dirY;
    const py = dirX;
    const bx = x + dirX * ARROW.len;
    const by = y + dirY * ARROW.len;
    return `<path d="M ${f(x)} ${f(y)} L ${f(bx + px * ARROW.half)} ${f(by + py * ARROW.half)} L ${f(bx - px * ARROW.half)} ${f(
      by - py * ARROW.half,
    )} Z" fill="#000"/>`;
  };
  const tw = dim.text.length * FONT * 0.6 + 2;
  if (dim.dir === 'h') {
    const [x1] = map(dim.p1, ext[va][0]);
    const [x2] = map(dim.p2, ext[va][0]);
    const sideTop = dim.side === 'top';
    const yDim = sideTop ? box.y0 - off : box.y1 + off;
    const sgn = sideTop ? -1 : 1;
    const yA1 = dim.a1 === undefined ? (sideTop ? box.y0 : box.y1) + sgn * 1 : map(dim.p1, dim.a1)[1];
    const yA2 = dim.a2 === undefined ? (sideTop ? box.y0 : box.y1) + sgn * 1 : map(dim.p2, dim.a2)[1];
    out.push(extLine(x1, yA1, x1, yDim + sgn * 1.5, false));
    out.push(extLine(x2, yA2, x2, yDim + sgn * 1.5, dim.ext === 'center'));
    out.push(lineEl(x1, yDim, x2, yDim, LW.dim));
    out.push(arrow(x1, yDim, 1, 0), arrow(x2, yDim, -1, 0));
    const mid = (x1 + x2) / 2;
    if (Math.abs(x2 - x1) >= tw + 2 * ARROW.len + 1) {
      out.push(`<rect x="${f(mid - tw / 2)}" y="${f(yDim - FONT * 0.5)}" width="${f(tw)}" height="${f(FONT * 1.05)}" fill="#fff"/>`);
      out.push(textEl(mid, yDim + FONT * 0.35, dim.text));
    } else {
      out.push(textEl(mid, sideTop ? yDim - 1.2 : yDim + 1.2 + FONT * 0.72, dim.text));
    }
  } else {
    const [, y1] = map(ext[ha][0], dim.p1);
    const [, y2] = map(ext[ha][0], dim.p2);
    const sideLeft = dim.side === 'left';
    const xDim = sideLeft ? box.x0 - off : box.x1 + off;
    const sgn = sideLeft ? -1 : 1;
    const xA1 = dim.a1 === undefined ? (sideLeft ? box.x0 : box.x1) + sgn * 1 : map(dim.a1, dim.p1)[0];
    const xA2 = dim.a2 === undefined ? (sideLeft ? box.x0 : box.x1) + sgn * 1 : map(dim.a2, dim.p2)[0];
    out.push(extLine(xA1, y1, xDim + sgn * 1.5, y1, false));
    out.push(extLine(xA2, y2, xDim + sgn * 1.5, y2, dim.ext === 'center'));
    out.push(lineEl(xDim, y1, xDim, y2, LW.dim));
    out.push(arrow(xDim, y1, 0, 1), arrow(xDim, y2, 0, -1));
    const mid = (y1 + y2) / 2;
    if (Math.abs(y2 - y1) >= tw + 2 * ARROW.len + 1) {
      out.push(`<rect x="${f(xDim - FONT * 0.5)}" y="${f(mid - tw / 2)}" width="${f(FONT * 1.05)}" height="${f(tw)}" fill="#fff"/>`);
      out.push(textEl(xDim + FONT * 0.35, mid, dim.text, { rotate: -90 }));
    } else {
      out.push(textEl(sideLeft ? xDim - 1.2 : xDim + 1.2 + FONT * 0.72, mid, dim.text, { rotate: -90 }));
    }
  }
  return out.join('\n');
}

/** Etichetta con freccia (leader) per Ø di fori e diametri dei gradini. */
function labelEl(p, lab) {
  const [x, y] = p;
  const ex = x + lab.dx;
  const ey = y + lab.dy;
  const anchor = lab.dx >= 0 ? 'start' : 'end';
  const tx = ex + (lab.dx >= 0 ? 0.8 : -0.8);
  return [
    `<circle cx="${f(x)}" cy="${f(y)}" r="0.6" fill="#000"/>`,
    lineEl(x, y, ex, ey, LW.dim),
    textEl(tx, ey + 1.1, lab.text, { anchor }),
  ].join('\n');
}

function viewEl(drawing, name, map, layout) {
  const view = drawing.views[name];
  const out = [];
  const [ha, va] = view.axes;
  const { ext } = drawing;
  const k = layout.k;
  const sp = (h, v) => map[name](h, v);

  for (const poly of view.polys) {
    const pts = poly.pts.map(([h, v]) => sp(h, v));
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${f(x)} ${f(y)}`).join(' ') + (poly.closed ? ' Z' : '');
    out.push(`<path d="${d}" fill="none" stroke="#000" stroke-width="${LW.visible}" stroke-linejoin="round"/>`);
  }
  for (const c of view.circles) {
    const [cx, cy] = sp(c.c[0], c.c[1]);
    out.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(c.r * k)}" fill="none" stroke="#000" stroke-width="${LW.visible}"/>`);
  }
  for (const l of view.lines) {
    const [x1, y1] = sp(l.p[0], l.p[1]);
    const [x2, y2] = sp(l.q[0], l.q[1]);
    if (l.style === 'hidden') out.push(lineEl(x1, y1, x2, y2, LW.hidden, DASH.hidden));
    else if (l.style === 'center') out.push(lineEl(x1, y1, x2, y2, LW.center, DASH.center));
    else out.push(lineEl(x1, y1, x2, y2, LW.visible));
  }
  // Riquadro della vista (per ancorare quote e nome vista).
  const bx0 = sp(ext[ha][0], ext[va][0])[0];
  const bx1 = sp(ext[ha][1], ext[va][0])[0];
  const by0 = sp(ext[ha][0], ext[va][1])[1];
  const by1 = sp(ext[ha][0], ext[va][0])[1];
  const box = { x0: Math.min(bx0, bx1), x1: Math.max(bx0, bx1), y0: Math.min(by0, by1), y1: Math.max(by0, by1) };
  for (const lab of view.labels) out.push(labelEl(sp(lab.at[0], lab.at[1]), lab));
  for (const d of view.dims) out.push(dimEl(drawing, name, d, map[name], box));
  return { svg: out.join('\n'), box };
}

function titleBlockEl(drawing, layout, meta) {
  const { x0, y0, x1, y1 } = TB;
  const c1 = 182;
  const c2 = 222;
  const r1 = 170;
  const r2 = 180;
  const r3 = 190;
  const cell = (x, y, label, value, size = 3.6) =>
    textEl(x + 2, y + 3.2, label, { size: 2.2, anchor: 'start', fill: '#555' }) +
    textEl(x + 2, y + 7.6, value, { size, anchor: 'start' });
  const refLabel = drawing.refAxis === 'h' ? 'orizzontale' : 'verticale';
  const kindLabel = {
    round: 'Rotazionale',
    prism: 'Profilo estruso',
    plate: 'Piastra piatta',
  }[drawing.summary.mode];
  const depthTxt =
    drawing.summary.mode === 'round'
      ? '—'
      : `${formatMm(drawing.depthPct)} % di W = ${formatMm(drawing.depthMm)} mm`;
  const date = meta.date || '';
  return [
    `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#fff" stroke="#000" stroke-width="0.35"/>`,
    lineEl(x0, r1, x1, r1, LW.visible),
    lineEl(x0, r2, x1, r2, LW.visible),
    lineEl(x0, r3, x1, r3, LW.visible),
    lineEl(c1, r1, c1, r3, LW.visible),
    lineEl(c2, r1, c2, r3, LW.visible),
    cell(x0, y0, 'TITOLO', meta.title || 'Disegno', 5),
    cell(x0, r1, 'SCALA', layout.ratioLabel),
    cell(c1, r1, 'FORMATO', 'A4 orizzontale'),
    cell(c2, r1, 'DATA', date),
    cell(x0, r2, 'QUOTA DI RIFERIMENTO', `${formatMm(drawing.refMm)} mm (${refLabel})`, 3.2),
    cell(c1, r2, 'OGGETTO', kindLabel, 3.2),
    cell(c2, r2, 'PROFONDITÀ', depthTxt, 2.8),
    textEl(x0 + 2, r3 + 3.2, 'NOTE', { size: 2.2, anchor: 'start', fill: '#555' }),
    textEl(
      x0 + 2,
      r3 + 7.4,
      'Quote in mm. Ricostruzione da foto: una sola quota reale, tutte le altre in proporzione.',
      { size: 2.9, anchor: 'start' },
    ),
  ].join('\n');
}

/**
 * Genera la tavola SVG.
 * @param {object} drawing  output di buildDrawing()
 * @param {{title?:string,date?:string}} meta
 * @param {{inline?:boolean}} opts  inline: SVG adattivo per la pagina; altrimenti in mm per la stampa.
 * @returns {{svg:string, layout:object}}
 */
export function renderSheet(drawing, meta = {}, { inline = false } = {}) {
  const layout = chooseLayout(drawing);
  const map = mapper(drawing, layout);
  const parts = [];
  const names = [];
  for (const name of ['TOP', 'FRONT', 'RIGHT']) {
    const { svg, box } = viewEl(drawing, name, map, layout);
    parts.push(svg);
    names.push({ name, box });
  }
  // Nomi delle viste, in basso a destra di ciascuna vista.
  const labels = names
    .map(({ name, box }) => {
      const txt = { TOP: "VISTA DALL'ALTO", FRONT: 'VISTA FRONTALE', RIGHT: 'VISTA DA DESTRA' }[name];
      // Il nome della vista sta sotto l'ultima quota inferiore (mai sopra di essa).
      const below = drawing.views[name].dims.filter((d) => d.side === 'bottom').map((d) => offsetOf(d.level ?? 0));
      const dy = below.length ? Math.max(...below) + 5 : 6.5;
      return textEl(box.x1, box.y1 + dy, txt, { size: 3, anchor: 'end', weight: 'bold' });
    })
    .join('\n');
  const frame = `<rect x="${FRAME.x0}" y="${FRAME.y0}" width="${FRAME.x1 - FRAME.x0}" height="${FRAME.y1 - FRAME.y0}" fill="none" stroke="#000" stroke-width="0.5"/>`;
  const size = inline ? '' : ` width="${PAGE.w}mm" height="${PAGE.h}mm"`;
  const cls = inline ? ' class="sheet-svg"' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"${cls}${size} viewBox="0 0 ${PAGE.w} ${PAGE.h}">
<rect x="0" y="0" width="${PAGE.w}" height="${PAGE.h}" fill="#fff"/>
${frame}
${parts.join('\n')}
${labels}
${titleBlockEl(drawing, layout, meta)}
</svg>`;
  return { svg, layout };
}
