// Test end-to-end nel browser: foto → tavola → SVG / PNG 300 dpi / stampa A4.
// Richiede un binario Chromium in CHROME_PATH (default /tmp/chromium) e, se serve,
// LD_LIBRARY_PATH con le librerie di sistema. Senza binario il test viene saltato.
// La CDN di OpenCV.js viene simulata con il pacchetto npm locale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';
import { bracketScene } from './helpers/synth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WEBAPP = join(here, '..', '..', 'webapp');
const CV_LOCAL = join(here, 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv.js');
const CV_CDN = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const CHROME = process.env.CHROME_PATH || '/tmp/chromium';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const skipReason = existsSync(CHROME) ? false : `Chromium non trovato in ${CHROME} (imposta CHROME_PATH)`;

function serveWebapp() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(WEBAPP, p);
      if (!file.startsWith(WEBAPP) || !existsSync(file)) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForFile(dir, ext, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const f = readdirSync(dir).find((n) => n.endsWith(ext) && !n.endsWith('.crdownload'));
    if (f) return join(dir, f);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`nessun download ${ext} in ${dir}`);
}

test('foto → tavola → SVG, PNG 300 dpi e stampa A4', { skip: skipReason, timeout: 300000 }, async () => {
  const server = await serveWebapp();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const dir = mkdtempSync(join(tmpdir(), 'td-e2e-'));
  const downloads = join(dir, 'downloads');
  mkdirSync(downloads);

  // Foto sintetica: una staffa con due fori, 800 × 600 px, 4 px/mm.
  const scene = bracketScene();
  const png = new PNG({ width: scene.w, height: scene.h });
  png.data = Buffer.from(scene.rgba);
  const photo = join(dir, 'staffa.png');
  writeFileSync(photo, PNG.sync.write(png));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-zygote', '--single-process'],
    defaultViewport: { width: 1280, height: 900 },
  });
  try {
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u === CV_CDN) return req.respond({ status: 200, contentType: 'text/javascript', body: readFileSync(CV_LOCAL) });
      if (u.startsWith(base)) return req.continue();
      return req.abort();
    });
    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    await page.goto(base, { waitUntil: 'load' });
    assert.equal(await page.$eval('#generate', (b) => b.disabled), true, 'senza foto il pulsante è disattivo');

    // 1 · foto
    const input = await page.$('#file');
    await input.uploadFile(photo);
    await page.waitForFunction(() => !document.getElementById('photo').hidden, { timeout: 30000 });
    assert.equal(await page.$eval('#title', (e) => e.value), 'staffa', 'titolo dal nome file');

    // area di selezione: trascinamento sulla foto → il ripristino si attiva
    const box = await (await page.$('#photo')).boundingBox();
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.$eval('#roi-reset', (b) => b.disabled), false, 'area selezionata');

    // 2 · impostazioni: staffa, quota verticale 40 mm (una sola quota reale)
    await page.click('input[name="mode"][value="prism"]');
    assert.equal(await page.$eval('#depth', (e) => e.value), '50', 'profondità di default per il profilo estruso');
    await page.select('#ref-axis', 'v');
    await page.type('#ref-mm', '40');
    assert.equal(await page.$eval('#generate', (b) => b.disabled), false, 'pronto a generare');

    // 3 · tavola
    await page.click('#generate');
    await page.waitForSelector('#sheet svg', { timeout: 240000 });
    const info = await page.$eval('#info', (e) => e.textContent);
    const m = info.match(/larghezza ([\d.]+) · altezza ([\d.]+) · profondità ([\d.]+) mm/);
    assert.ok(m, `info senza misure: ${info}`);
    const [W, H, D] = m.slice(1).map(Number);
    assert.ok(Math.abs(W - 60) / 60 < 0.02, `larghezza ${W}`);
    assert.ok(Math.abs(H - 40) / 40 < 0.02, `altezza ${H}`);
    assert.ok(Math.abs(D - 30) / 30 < 0.02, `profondità ${D}`);
    assert.match(info, /quota reale 40 mm \(verticale\)/);
    assert.match(info, /2 fori Ø 5\.9 mm/);
    const sheetText = await page.$eval('#sheet', (e) => e.textContent);
    for (const label of ['VISTA DALL\'ALTO', 'VISTA FRONTALE', 'VISTA DA DESTRA', 'A4 orizzontale']) {
      assert.ok(sheetText.includes(label), `manca "${label}" nella tavola`);
    }
    assert.equal(await page.$eval('#dl-svg', (b) => b.disabled), false, 'export attivo dopo la generazione');

    // Una sola quota cambiata (40 → 80 mm): il risultato precedente va aggiornato
    // e tutte le misure raddoppiano (larghezza 60 → 120 mm).
    await page.click('#ref-mm', { clickCount: 3 });
    await page.type('#ref-mm', '80');
    assert.match(await page.$eval('#status', (e) => e.textContent), /Parametri modificati/);
    assert.equal(await page.$eval('#dl-svg', (b) => b.disabled), true, 'export disattivo finché non si rigenera');
    await page.click('#generate');
    await page.waitForFunction(() => !document.getElementById('dl-svg').disabled, { timeout: 60000 });
    const info80 = await page.$eval('#info', (e) => e.textContent);
    assert.match(info80, /quota reale 80 mm \(verticale\)/);
    const W80 = Number(info80.match(/larghezza ([\d.]+)/)[1]);
    assert.ok(Math.abs(W80 - 120) / 120 < 0.02, `con 80 mm la larghezza deve essere ~120, ottenuto ${W80}`);

    // 4 · esportazioni
    await page.click('#dl-svg');
    const svgFile = await waitForFile(downloads, '.svg');
    const svgText = readFileSync(svgFile, 'utf8');
    assert.ok(svgText.startsWith('<svg') && svgText.includes('width="297mm"'), 'SVG in mm su A4');
    assert.ok(!/NaN|undefined/.test(svgText), 'SVG senza valori mancanti');

    await page.click('#dl-png');
    const pngFile = await waitForFile(downloads, '.png');
    const decoded = PNG.sync.read(readFileSync(pngFile));
    assert.equal(decoded.width, 3508, 'PNG larghezza 300 dpi');
    assert.equal(decoded.height, 2480, 'PNG altezza 300 dpi');
    let dark = 0;
    for (let i = 0; i < decoded.data.length; i += 4 * 97) if (decoded.data[i] < 100) dark++;
    assert.ok(dark > 500, `PNG quasi vuoto (pixel scuri campionati: ${dark})`);

    // 5 · stampa: in media print resta solo la tavola, su 297 × 210 mm
    await page.emulateMediaType('print');
    const printed = await page.evaluate(() => ({
      header: getComputedStyle(document.querySelector('header')).display,
      svgWidthMm: document.querySelector('#sheet svg').getBoundingClientRect().width / (96 / 25.4),
    }));
    assert.equal(printed.header, 'none', 'in stampa l\'intestazione è nascosta');
    assert.ok(Math.abs(printed.svgWidthMm - 297) < 1, `larghezza di stampa ${printed.svgWidthMm} mm`);
    await page.emulateMediaType('screen');

    if (process.env.TD_OUT) {
      // Copie per ispezione manuale (fuori dal repository).
      mkdirSync(process.env.TD_OUT, { recursive: true });
      copyFileSync(svgFile, join(process.env.TD_OUT, 'tavola.svg'));
      copyFileSync(pngFile, join(process.env.TD_OUT, 'tavola-300dpi.png'));
      await page.setViewport({ width: 1280, height: 1500 });
      await page.screenshot({ path: join(process.env.TD_OUT, 'pagina.png'), fullPage: true });
    }

    assert.deepEqual(problems, [], `errori nel browser:\n${problems.join('\n')}`);
  } finally {
    await browser.close();
    server.close();
  }
});
