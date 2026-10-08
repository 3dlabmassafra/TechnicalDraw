// Anteprima visiva delle tavole sulle foto sintetiche (SVG + PNG), per controllo a occhio.
// Uso: npm run preview [cartella-output]   (default: cartella temporanea del sistema)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Resvg } from '@resvg/resvg-js';
import { loadCv } from './helpers/cv.mjs';
import { bracketScene, shaftScene, plateScene } from './helpers/synth.mjs';
import { segmentPhoto } from '../../webapp/js/segment.js';
import { buildDrawing } from '../../webapp/js/geometry.js';
import { renderSheet } from '../../webapp/js/sheet.js';

const out = process.argv[2] || join(tmpdir(), 'technicaldraw-preview');
mkdirSync(out, { recursive: true });
const { cv } = await loadCv();
const cases = [
  ['staffa', 'prism', bracketScene(), { refAxis: 'v', refMm: 40, depthPct: 50 }],
  ['albero', 'round', shaftScene(), { refAxis: 'h', refMm: 30 }],
  ['piastra', 'plate', plateScene(), { refAxis: 'h', refMm: 120, depthPct: 5 }],
];
for (const [name, mode, scene, opts] of cases) {
  const mat = cv.matFromImageData({ data: scene.rgba, width: scene.w, height: scene.h });
  let features;
  try {
    features = segmentPhoto(cv, mat, null);
  } finally {
    mat.delete();
  }
  const drawing = buildDrawing(features, { mode, ...opts });
  const { svg, layout } = renderSheet(drawing, { title: name, date: '08/10/2026' }, { inline: false });
  writeFileSync(join(out, `${name}.svg`), svg);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 2000 }, background: 'white' }).render().asPng();
  writeFileSync(join(out, `${name}.png`), png);
  console.log(`${name}: scala ${layout.ratioLabel} → ${join(out, `${name}.png`)}`);
}
