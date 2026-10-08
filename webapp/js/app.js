// Foto → tavola tecnica A4. L'elaborazione avviene nel browser: la foto non lascia il dispositivo.
import { segmentPhoto, defaultRoi, SegmentationError } from './segment.js';
import { buildDrawing, formatMm } from './geometry.js';
import { renderSheet } from './sheet.js';

const CV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const CV_TIMEOUT_MS = 120000;
const MAX_PHOTO_SIDE = 1600; // la segmentazione lavora a 1000 px: qui basta un po' di margine
const EXPORT_PX = { w: 3508, h: 2480 }; // A4 orizzontale a 300 dpi
const DEPTH_DEFAULT = { prism: '50', plate: '10' };
const MODE_HINT = {
  round: 'Silhouette = profilo di rotazione. Vista dall’alto: cerchi concentrici; fronte e destra: profilo.',
  prism: 'Il profilo della foto viene estruso in profondità. La profondità è una percentuale della larghezza (default 50 %).',
  plate: 'Pezzo piatto fotografato dall’alto. Lo spessore è una percentuale della larghezza (default 10 %).',
};

const el = {
  file: document.getElementById('file'),
  drop: document.getElementById('drop'),
  photo: document.getElementById('photo'),
  roiReset: document.getElementById('roi-reset'),
  refMm: document.getElementById('ref-mm'),
  refAxis: document.getElementById('ref-axis'),
  depth: document.getElementById('depth'),
  depthField: document.getElementById('depth-field'),
  modeHint: document.getElementById('mode-hint'),
  title: document.getElementById('title'),
  generate: document.getElementById('generate'),
  status: document.getElementById('status'),
  info: document.getElementById('info'),
  sheet: document.getElementById('sheet'),
  dlSvg: document.getElementById('dl-svg'),
  dlPng: document.getElementById('dl-png'),
  dlPdf: document.getElementById('dl-pdf'),
  axisRound: null,
};
el.axisRound = el.refAxis.options[0];

const st = {
  cvPromise: null,
  photo: null, // canvas con la foto ridotta: sorgente per la segmentazione
  roi: null, // {x,y,w,h} in pixel della foto; null = area predefinita
  drag: null, // {x0,y0,x1,y1} durante il trascinamento
  features: null, // ultimo risultato di segmentPhoto (per il contorno sovrapposto)
  svg: null, // SVG della tavola (in mm, per export)
  title: 'Disegno',
};

// ---------- utilità ----------

const setStatus = (msg, isError = false) => {
  el.status.textContent = msg;
  el.status.classList.toggle('error', isError);
};

const selectedMode = () => document.querySelector('input[name="mode"]:checked').value;

const numberOf = (input) => Number(String(input.value).trim().replace(',', '.'));

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('formato non supportato o file danneggiato'));
    img.src = src;
  });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 2000);
}

const fileBase = () =>
  (st.title || 'disegno')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'disegno';

/** Rettangolo normalizzato e ritagliato alla foto, dal trascinamento. */
function rectOf(d, W, H) {
  const x0 = Math.max(0, Math.min(d.x0, d.x1));
  const y0 = Math.max(0, Math.min(d.y0, d.y1));
  const x1 = Math.min(W, Math.max(d.x0, d.x1));
  const y1 = Math.min(H, Math.max(d.y0, d.y1));
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

// ---------- OpenCV.js (caricato solo quando serve) ----------

/**
 * Carica OpenCV.js dalla CDN una sola volta. Risolve con { cv }: il modulo è thenable,
 * quindi non va risolto direttamente (si entrerebbe in loop).
 */
function loadCv() {
  if (st.cvPromise) return st.cvPromise;
  st.cvPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CV_URL;
    script.async = true;
    script.onerror = () => {
      st.cvPromise = null;
      reject(new Error('impossibile scaricare OpenCV.js dalla CDN: controlla la connessione e riprova'));
    };
    script.onload = () => {
      if (typeof cv === 'undefined') {
        st.cvPromise = null;
        return reject(new Error('OpenCV.js non è disponibile dopo il caricamento'));
      }
      let done = false;
      const ready = (mod) => {
        if (done) return;
        done = true;
        resolve({ cv: mod });
      };
      const timer = setTimeout(() => {
        if (done) return;
        st.cvPromise = null;
        reject(new Error('OpenCV.js non si è inizializzato in tempo'));
      }, CV_TIMEOUT_MS);
      const finish = (mod) => {
        clearTimeout(timer);
        ready(mod);
      };
      if (cv.Mat) return finish(cv);
      cv.onRuntimeInitialized = () => finish(cv);
      if (typeof cv.then === 'function') cv.then((mod) => finish(mod));
    };
    document.head.append(script);
  });
  return st.cvPromise;
}

// ---------- foto e area di selezione ----------

function drawPhoto() {
  el.photo.hidden = !st.photo;
  if (!st.photo) return;
  const c = el.photo;
  c.width = st.photo.width;
  c.height = st.photo.height;
  const g = c.getContext('2d');
  g.drawImage(st.photo, 0, 0);
  const W = c.width;
  const H = c.height;
  const r = st.drag ? rectOf(st.drag, W, H) : st.roi || defaultRoi(W, H);
  const lw = Math.max(2, W / 350);
  g.lineWidth = lw;
  g.setLineDash([lw * 4, lw * 2]);
  g.strokeStyle = '#ff8f00';
  g.strokeRect(r.x, r.y, r.w, r.h);
  g.setLineDash([]);
  if (st.features) {
    // Il contorno è in pixel di lavoro: si riporta alla foto dividendo per la scala.
    const s = 1 / st.features.scale;
    g.beginPath();
    st.features.outline.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
    g.closePath();
    g.lineWidth = lw * 1.2;
    g.strokeStyle = '#00c853';
    g.stroke();
  }
}

/** Parametri cambiati (o area cambiata): il risultato precedente non vale più. */
function invalidate() {
  st.features = null;
  setExportEnabled(false);
  if (st.photo) drawPhoto();
  if (st.svg) setStatus('Parametri modificati: premi «Genera tavola» per aggiornare la tavola.');
}

function setExportEnabled(on) {
  el.dlSvg.disabled = !on;
  el.dlPng.disabled = !on;
  el.dlPdf.disabled = !on;
}

function updateControls() {
  el.generate.disabled = !st.photo || !(numberOf(el.refMm) > 0);
  el.roiReset.disabled = !st.roi;
  el.depthField.hidden = selectedMode() === 'round';
  el.axisRound.textContent = selectedMode() === 'round' ? 'orizzontale (Ø massimo)' : 'orizzontale (larghezza)';
}

async function openFile(file) {
  if (!file.type.startsWith('image/')) return setStatus('Il file scelto non è un’immagine.', true);
  setStatus('Apro la foto…');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    st.photo = c;
    st.roi = null;
    st.features = null;
    el.title.value = file.name.replace(/\.[^.]+$/, '') || 'Disegno';
    st.title = el.title.value;
    el.sheet.innerHTML = '';
    el.info.textContent = '';
    st.svg = null;
    setExportEnabled(false);
    drawPhoto();
    updateControls();
    setStatus('Foto caricata. Trascina un rettangolo attorno all’oggetto (opzionale), inserisci la quota reale e premi «Genera tavola».');
    loadCv().catch(() => {}); // precarica OpenCV in background: eventuali errori compaiono alla generazione
  } catch (err) {
    setStatus(`Foto non leggibile: ${err.message}.`, true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- generazione ----------

function readParams() {
  const mode = selectedMode();
  const refMm = numberOf(el.refMm);
  const depthPct = mode === 'round' ? 50 : numberOf(el.depth);
  if (!(refMm > 0)) return { error: 'Inserisci la quota reale in mm (maggiore di zero).' };
  if (!(depthPct > 0 && depthPct <= 500)) return { error: 'La profondità deve essere tra 1 e 500 % della larghezza.' };
  return { mode, refMm, refAxis: el.refAxis.value, depthPct, title: el.title.value.trim() || 'Disegno' };
}

function describe(drawing, layout, features, p) {
  const s = drawing.summary;
  const axis = p.refAxis === 'h' ? 'orizzontale' : 'verticale';
  let dims;
  if (drawing.mode === 'round') {
    const steps = s.gradini.map((g) => formatMm(g.d)).join(' / ') || '—';
    dims = `Ø max ${formatMm(s.diametro)} · altezza ${formatMm(s.altezza)} mm · gradini Ø ${steps}`;
  } else if (drawing.mode === 'prism') {
    dims = `larghezza ${formatMm(s.larghezza)} · altezza ${formatMm(s.altezza)} · profondità ${formatMm(s.profondita)} mm`;
  } else {
    dims = `larghezza ${formatMm(s.larghezza)} · lunghezza ${formatMm(s.lunghezza)} · spessore ${formatMm(s.spessore)} mm`;
  }
  const parts = [
    `Scala ${layout.ratioLabel}`,
    `quota reale ${formatMm(p.refMm)} mm (${axis})`,
    `misure ricavate: ${dims}`,
  ];
  if (s.fori.length) {
    const d = [...new Set(s.fori.map((h) => formatMm(h.d)))].join(' / ');
    parts.push(`${s.fori.length} fori Ø ${d} mm`);
  }
  parts.push(`segmentazione: ${features.method === 'color' ? 'colore' : 'GrabCut (lenta)'}`);
  if (!layout.fits) parts.push('attenzione: il disegno non entra in A4 nemmeno a 1:50. Verifica la quota inserita.');
  if (features.warnings && features.warnings.length) parts.push(...features.warnings);
  return parts.join(' · ');
}

async function generate() {
  const p = readParams();
  if (p.error) return setStatus(p.error, true);
  if (!st.photo) return;
  el.generate.disabled = true;
  setExportEnabled(false);
  try {
    setStatus('Carico OpenCV.js (solo la prima volta)…');
    const { cv: cvLib } = await loadCv();
    setStatus('Segmentazione dell’oggetto…');
    await nextFrame();
    const { width, height } = st.photo;
    const imageData = st.photo.getContext('2d').getImageData(0, 0, width, height);
    const mat = cvLib.matFromImageData(imageData);
    let features;
    try {
      features = segmentPhoto(cvLib, mat, st.roi);
    } finally {
      mat.delete();
    }
    const drawing = buildDrawing(features, p);
    const meta = {
      title: p.title,
      date: new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }),
    };
    const { svg, layout } = renderSheet(drawing, meta, { inline: false });
    st.features = features;
    st.svg = svg;
    st.title = p.title;
    el.sheet.innerHTML = svg;
    el.info.textContent = describe(drawing, layout, features, p);
    setExportEnabled(true);
    drawPhoto();
    setStatus('Tavola generata. Puoi scaricarla o stamparla in PDF.');
  } catch (err) {
    console.error(err);
    st.features = null;
    drawPhoto();
    setStatus(err instanceof SegmentationError ? err.message : `Errore durante la generazione: ${err.message}`, true);
  } finally {
    updateControls();
  }
}

// ---------- esportazione ----------

async function exportPng() {
  if (!st.svg) return;
  setStatus('Creo il PNG a 300 dpi…');
  const url = URL.createObjectURL(new Blob([st.svg], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const c = document.createElement('canvas');
    c.width = EXPORT_PX.w;
    c.height = EXPORT_PX.h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG non generato'))), 'image/png'),
    );
    download(blob, `${fileBase()}_300dpi.png`);
    setStatus(`PNG creato: ${EXPORT_PX.w} × ${EXPORT_PX.h} px (A4 a 300 dpi).`);
  } catch (err) {
    setStatus(`Esportazione PNG non riuscita: ${err.message}.`, true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- eventi ----------

el.file.addEventListener('change', () => {
  if (el.file.files[0]) openFile(el.file.files[0]);
});
el.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.drop.classList.add('over');
});
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('over'));
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

const pointOf = (e) => {
  const r = el.photo.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * el.photo.width) / r.width,
    y: ((e.clientY - r.top) * el.photo.height) / r.height,
  };
};
el.photo.addEventListener('pointerdown', (e) => {
  if (!st.photo) return;
  el.photo.setPointerCapture(e.pointerId);
  const p = pointOf(e);
  st.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  drawPhoto();
});
el.photo.addEventListener('pointermove', (e) => {
  if (!st.drag) return;
  const p = pointOf(e);
  st.drag.x1 = p.x;
  st.drag.y1 = p.y;
  drawPhoto();
});
const endDrag = () => {
  if (!st.drag) return;
  const r = rectOf(st.drag, el.photo.width, el.photo.height);
  st.drag = null;
  if (r.w >= 20 && r.h >= 20) {
    st.roi = r; // i semplici clic (rettangolo troppo piccolo) vengono ignorati
    invalidate();
  }
  updateControls();
  drawPhoto();
};
el.photo.addEventListener('pointerup', endDrag);
el.photo.addEventListener('pointercancel', endDrag);

el.roiReset.addEventListener('click', () => {
  st.roi = null;
  invalidate();
  updateControls();
});

for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => {
    const m = selectedMode();
    el.modeHint.textContent = MODE_HINT[m];
    if (DEPTH_DEFAULT[m]) el.depth.value = DEPTH_DEFAULT[m];
    updateControls();
    invalidate();
  });
}
for (const input of [el.refMm, el.depth, el.title]) {
  input.addEventListener('input', () => {
    updateControls();
    invalidate();
  });
}
el.refAxis.addEventListener('change', () => {
  updateControls();
  invalidate();
});

el.generate.addEventListener('click', generate);
el.dlSvg.addEventListener('click', () => download(new Blob([st.svg], { type: 'image/svg+xml' }), `${fileBase()}.svg`));
el.dlPng.addEventListener('click', exportPng);
el.dlPdf.addEventListener('click', () => window.print());

// ---------- avvio ----------
el.modeHint.textContent = MODE_HINT[selectedMode()];
el.depth.value = DEPTH_DEFAULT[selectedMode()] ?? el.depth.value;
updateControls();
setStatus('Carica una foto per iniziare. La foto resta nel tuo browser.');
