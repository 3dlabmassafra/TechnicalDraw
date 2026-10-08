// Test del modello geometrico e della tavola su foto sintetiche con quote note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCv } from './helpers/cv.mjs';
import { bracketScene, shaftScene, plateScene } from './helpers/synth.mjs';
import { segmentPhoto } from '../../webapp/js/segment.js';
import { buildDrawing, formatMm, simplifyOpen, stepLevels } from '../../webapp/js/geometry.js';
import { renderSheet } from '../../webapp/js/sheet.js';

const { cv } = await loadCv();

function featuresOf(scene) {
  const mat = cv.matFromImageData({ data: scene.rgba, width: scene.w, height: scene.h });
  try {
    return segmentPhoto(cv, mat, null);
  } finally {
    mat.delete();
  }
}

const near = (actual, expected, relTol, absTol = 0) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.max(absTol, relTol * Math.abs(expected)),
    `atteso ${expected} ± ${Math.max(absTol, relTol * Math.abs(expected)).toFixed(3)}, ottenuto ${actual}`,
  );

test('formatMm: un decimale, senza zeri inutili', () => {
  assert.equal(formatMm(5.944), '5.9');
  assert.equal(formatMm(30), '30');
  assert.equal(formatMm(17.5), '17.5');
  assert.equal(formatMm(0.04), '0');
  assert.equal(formatMm(-0.04), '0');
  assert.equal(formatMm(19.625), '19.6');
});

test('simplifyOpen mantiene gli spigoli e scarta i punti allineati', () => {
  const line = [[0, 0], [1, 0.01], [2, 0], [3, 0]];
  assert.deepEqual(simplifyOpen(line, 0.1), [[0, 0], [3, 0]]);
  const corner = [[0, 0], [5, 0], [5, 5]];
  assert.equal(simplifyOpen(corner, 0.1).length, 3);
});

test('stepLevels fonde i bordi della zona di transizione e fissa gli estremi', () => {
  const levels = stepLevels([0, 80, 0.1, 19.625, 20.625, 59.375, 60.375, 80], 80, 1.6);
  assert.deepEqual(levels, [0, 20.125, 59.875, 80]);
});

test('staffa (prisma): W 60, H 40, profondità 30 mm, fori Ø 6 con posizioni note', () => {
  const f = featuresOf(bracketScene());
  const d = buildDrawing(f, { mode: 'prism', refAxis: 'v', refMm: 40, depthPct: 50 });
  const s = d.summary;
  near(s.larghezza, 60, 0.015);
  near(s.altezza, 40, 0.01);
  near(s.profondita, 30, 0.015);
  assert.equal(s.fori.length, 2);
  for (const h of s.fori) near(h.d, 6, 0.05);
  const byU = s.fori.map((h) => [h.u, h.v]).sort((a, b) => a[0] - b[0]);
  near(byU[0][0], 6, 0.03, 0.5);
  near(byU[0][1], 30, 0.03, 0.5);
  near(byU[1][0], 45, 0.03, 0.5);
  near(byU[1][1], 5, 0.03, 0.5);
});

test('albero (rotazionale): Ø max 30, H 80, gradini Ø 30 / 16 / 24', () => {
  const f = featuresOf(shaftScene());
  const d = buildDrawing(f, { mode: 'round', refAxis: 'h', refMm: 30 });
  const s = d.summary;
  near(s.diametro, 30, 0.02);
  near(s.altezza, 80, 0.02);
  const steps = s.gradini.slice().sort((a, b) => a.z0 - b.z0).map((g) => g.d);
  assert.equal(steps.length, 3, `gradini trovati: ${JSON.stringify(steps)}`);
  near(steps[0], 30, 0.03);
  near(steps[1], 16, 0.03);
  near(steps[2], 24, 0.03);
  // Cerchi della vista dall'alto: solo i raggi dei gradini (nessun raggio spurio).
  const radii = d.views.TOP.circles.map((c) => c.r).sort((a, b) => b - a);
  assert.equal(radii.length, 3, `cerchi: ${JSON.stringify(radii)}`);
  near(radii[0], 15, 0.03);
  near(radii[1], 12, 0.03);
  near(radii[2], 8, 0.03);
});

test('piastra: 120 × 60 × 6 mm, 4 fori Ø 6', () => {
  const f = featuresOf(plateScene());
  const d = buildDrawing(f, { mode: 'plate', refAxis: 'h', refMm: 120, depthPct: 5 });
  const s = d.summary;
  near(s.larghezza, 120, 0.01);
  near(s.lunghezza, 60, 0.02);
  near(s.spessore, 6, 0.02);
  assert.equal(s.fori.length, 4);
  for (const h of s.fori) near(h.d, 6, 0.05);
});

test('una sola quota: raddoppiando il riferimento tutte le misure raddoppiano', () => {
  const f = featuresOf(bracketScene());
  const a = buildDrawing(f, { mode: 'prism', refAxis: 'v', refMm: 40, depthPct: 50 }).summary;
  const b = buildDrawing(f, { mode: 'prism', refAxis: 'v', refMm: 80, depthPct: 50 }).summary;
  near(b.larghezza, 2 * a.larghezza, 1e-9);
  near(b.altezza, 2 * a.altezza, 1e-9);
  near(b.profondita, 2 * a.profondita, 1e-9);
  near(b.fori[0].d, 2 * a.fori[0].d, 1e-9);
});

test('asse della quota: stessa forma misurata in verticale o in orizzontale', () => {
  const f = featuresOf(shaftScene());
  const h = buildDrawing(f, { mode: 'round', refAxis: 'h', refMm: 30 }).summary;
  const v = buildDrawing(f, { mode: 'round', refAxis: 'v', refMm: 80 }).summary;
  near(v.diametro, h.diametro, 0.02);
  near(v.altezza, h.altezza, 0.02);
});

test('profondità in percentuale della larghezza', () => {
  const f = featuresOf(bracketScene());
  const d50 = buildDrawing(f, { mode: 'prism', refAxis: 'v', refMm: 40, depthPct: 50 });
  const d100 = buildDrawing(f, { mode: 'prism', refAxis: 'v', refMm: 40, depthPct: 100 });
  near(d100.depthMm, 2 * d50.depthMm, 1e-9);
  near(d100.depthMm, d100.summary.larghezza, 1e-9);
});

test('parametri non validi vengono rifiutati', () => {
  const f = featuresOf(bracketScene());
  assert.throws(() => buildDrawing(f, { mode: 'prism', refAxis: 'v', refMm: 0, depthPct: 50 }), /quota/);
  assert.throws(() => buildDrawing(f, { mode: 'prism', refAxis: 'v', refMm: 40, depthPct: 0 }), /Profondità/);
  assert.throws(() => buildDrawing(f, { mode: 'cubo', refAxis: 'v', refMm: 40, depthPct: 50 }), /Tipo/);
  assert.throws(() => buildDrawing(f, { mode: 'prism', refAxis: 'x', refMm: 40, depthPct: 50 }), /Asse/);
});

test('tavola SVG: viste, quote e cartiglio senza valori mancanti', () => {
  const cases = [
    ['prism', bracketScene(), { refAxis: 'v', refMm: 40, depthPct: 50 }],
    ['round', shaftScene(), { refAxis: 'h', refMm: 30 }],
    ['plate', plateScene(), { refAxis: 'h', refMm: 120, depthPct: 5 }],
  ];
  for (const [mode, scene, o] of cases) {
    const d = buildDrawing(featuresOf(scene), { mode, ...o });
    const { svg, layout } = renderSheet(d, { title: 'Prova ' + mode, date: '08/10/2026' }, { inline: false });
    assert.ok(svg.startsWith('<svg'), mode);
    assert.ok(svg.includes('width="297mm"') && svg.includes('height="210mm"'), mode);
    assert.ok(!/NaN|undefined|Infinity/.test(svg), `${mode}: valori non numerici nell'SVG`);
    assert.ok(svg.includes('VISTA FRONTALE'), `${mode}: nome vista FRONT`);
    assert.ok(svg.includes("VISTA DALL'ALTO"), `${mode}: nome vista TOP`);
    assert.ok(svg.includes(`${formatMm(o.refMm)} mm`), `${mode}: quota di riferimento nel cartiglio`);
    assert.ok(layout.k > 0 && layout.fits, `${mode}: scala ${layout.k}`);
  }
});
