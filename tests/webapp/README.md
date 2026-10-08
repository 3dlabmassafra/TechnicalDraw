# Test della webapp

Test automatici per la webapp in `webapp/` (non pubblicati su GitHub Pages).

```bash
cd tests/webapp
npm ci
npm test                 # unità (geometria, segmentazione, tavola) + E2E se trova Chromium
npm run preview          # SVG/PNG delle tre foto sintetiche, per controllo visivo
```

- `geometry.test.mjs`: quote ricostruite su foto sintetiche con misure note, scala da una sola quota, validazione dei parametri, tavola senza valori mancanti.
- `e2e.test.mjs`: apre la pagina in Chromium headless (puppeteer-core), carica la foto, trascina l'area, genera, cambia la quota da 40 a 80 mm, scarica SVG e PNG a 300 dpi, verifica la stampa A4. Serve un binario Chromium in `CHROME_PATH` (default `/tmp/chromium`); altrimenti viene saltato. OpenCV.js è servito dal pacchetto npm locale, perché la CDN non è raggiungibile in sandbox.
- `TD_OUT=cartella npm test` copia tavola SVG/PNG e screenshot della pagina nella cartella indicata.
