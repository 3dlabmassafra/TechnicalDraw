// Segmentazione dell'oggetto nella foto con OpenCV.js.
//
// Metodo principale (veloce, ~decine di ms): lo sfondo viene stimato dai pixel
// del bordo dell'area selezionata; ogni pixel viene confrontato con lo sfondo
// in Lab (la luminanza pesa meno, così le ombre pesano poco); una soglia di Otsu
// separa oggetto e sfondo.
// Fallback (lento ma robusto): GrabCut a bassa risoluzione, solo se il metodo
// veloce non trova un oggetto plausibile.
//
// Convenzione: il pixel intero (x, y) ha centro in (x + 0.5, y + 0.5).
// Le coordinate restituite sono nell'immagine di lavoro (width × height).

const MIN_OBJECT_FRACTION = 0.002; // oggetto minimo: 0.2% dell'area di lavoro
const MIN_HOLE_FRACTION = 0.0005; // foro minimo: 0.05% della silhouette
const WORK_MAX_SIDE = 1000; // risoluzione di lavoro massima
const GRABCUT_MAX_SIDE = 360; // GrabCut solo a bassa risoluzione (costoso)

export class SegmentationError extends Error {}

/** Area di default (4% di margine) in cui cercare l'oggetto. */
export function defaultRoi(width, height) {
  const mx = Math.round(width * 0.04);
  const my = Math.round(height * 0.04);
  return { x: mx, y: my, w: width - 2 * mx, h: height - 2 * my };
}

function normalizeRoi(roi, width, height) {
  const x0 = Math.max(0, Math.min(width - 3, Math.floor(roi.x)));
  const y0 = Math.max(0, Math.min(height - 3, Math.floor(roi.y)));
  const x1 = Math.max(x0 + 3, Math.min(width, Math.ceil(roi.x + roi.w)));
  const y1 = Math.max(y0 + 3, Math.min(height, Math.ceil(roi.y + roi.h)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function approxContour(cv, contour, epsilon) {
  const approx = new cv.Mat();
  try {
    cv.approxPolyDP(contour, approx, epsilon, true);
    const d = approx.data32S;
    const pts = [];
    for (let i = 0; i < approx.rows; i++) pts.push([d[2 * i], d[2 * i + 1]]);
    return pts;
  } finally {
    approx.delete();
  }
}

/** Soglia di Otsu su un istogramma a 256 classi. */
function otsuThreshold(hist, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

function robustStats(values) {
  const s = Float64Array.from(values).sort();
  const med = s[s.length >> 1];
  const dev = new Float64Array(s.length);
  for (let i = 0; i < s.length; i++) dev[i] = Math.abs(s[i] - med);
  dev.sort();
  const mad = dev[dev.length >> 1];
  return { med, sig: Math.max(3, 1.4826 * mad) };
}

/** Maschera di primo piano (0/255) con distanza di colore dallo sfondo stimato sul bordo. */
function colorMask(cv, rgb, W, H, roi, own) {
  const lab = own(new cv.Mat());
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  const fg = own(new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(0)));
  const dist = own(new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(0)));
  const L = lab.data;
  const D = dist.data;
  const F = fg.data;

  const x1 = roi.x + roi.w;
  const y1 = roi.y + roi.h;
  const band = Math.max(2, Math.round(0.03 * Math.min(roi.w, roi.h)));
  const bl = [];
  const ba = [];
  const bb = [];
  for (let y = roi.y; y < y1; y++) {
    for (let x = roi.x; x < x1; x++) {
      const edge = Math.min(x - roi.x, x1 - 1 - x, y - roi.y, y1 - 1 - y);
      if (edge >= band) continue;
      const p = (y * W + x) * 3;
      bl.push(L[p]);
      ba.push(L[p + 1]);
      bb.push(L[p + 2]);
    }
  }
  if (bl.length < 16) return null;
  const sL = robustStats(bl);
  const sa = robustStats(ba);
  const sb = robustStats(bb);

  const hist = new Float64Array(256);
  let total = 0;
  for (let y = roi.y; y < y1; y++) {
    for (let x = roi.x; x < x1; x++) {
      const p = (y * W + x) * 3;
      const dl = ((L[p] - sL.med) / sL.sig) * 0.5; // luminanza pesata: ombre quasi neutre
      const da = (L[p + 1] - sa.med) / sa.sig;
      const db = (L[p + 2] - sb.med) / sb.sig;
      const v = Math.min(255, Math.round(Math.hypot(dl, da, db) * 16));
      D[y * W + x] = v;
      hist[v]++;
      total++;
    }
  }
  const thr = otsuThreshold(hist, total);
  let count = 0;
  for (let y = roi.y; y < y1; y++) {
    for (let x = roi.x; x < x1; x++) {
      const i = y * W + x;
      if (D[i] > thr) {
        F[i] = 255;
        count++;
      }
    }
  }
  // Un'area di primo piano quasi tutta la ROI indica che lo sfondo non è separabile.
  if (count < 0.002 * W * H || count > 0.85 * roi.w * roi.h) return null;
  return fg;
}

/** Fallback: GrabCut a bassa risoluzione, maschera riportata alla risoluzione di lavoro. */
function grabCutMask(cv, rgb, W, H, roi, own) {
  const k = Math.min(1, GRABCUT_MAX_SIDE / Math.max(W, H));
  const sw = Math.max(16, Math.round(W * k));
  const sh = Math.max(16, Math.round(H * k));
  const small = own(new cv.Mat());
  cv.resize(rgb, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const m = own(new cv.Mat(sh, sw, cv.CV_8UC1, new cv.Scalar(0)));
  const bgd = own(new cv.Mat());
  const fgd = own(new cv.Mat());
  const rx = Math.floor((roi.x * sw) / W);
  const ry = Math.floor((roi.y * sh) / H);
  const rw = Math.max(3, Math.min(sw - rx, Math.ceil((roi.w * sw) / W)));
  const rh = Math.max(3, Math.min(sh - ry, Math.ceil((roi.h * sh) / H)));
  cv.grabCut(small, m, new cv.Rect(rx, ry, rw, rh), bgd, fgd, 3, cv.GC_INIT_WITH_RECT);
  const full = own(new cv.Mat());
  cv.resize(m, full, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST);
  const fg = own(new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(0)));
  const src = full.data;
  const dst = fg.data;
  for (let i = 0; i < src.length; i++) dst[i] = src[i] === 1 || src[i] === 3 ? 255 : 0;
  return fg;
}

/** Da una maschera di primo piano: pulizia, contorno esterno, silhouette e fori. */
function extractFeatures(cv, fgRaw, W, H, roi, own) {
  const kOpen = own(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
  const kClose = own(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7)));
  const opened = own(new cv.Mat());
  const fg = own(new cv.Mat());
  cv.morphologyEx(fgRaw, opened, cv.MORPH_OPEN, kOpen);
  cv.morphologyEx(opened, fg, cv.MORPH_CLOSE, kClose);

  const contours = own(new cv.MatVector());
  const hierarchy = own(new cv.Mat());
  cv.findContours(fg, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE);
  const hier = hierarchy.data32S;

  let outerIdx = -1;
  let outerArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    if (hier[i * 4 + 3] !== -1) continue;
    const c = contours.get(i);
    const area = cv.contourArea(c);
    c.delete();
    if (area > outerArea) {
      outerArea = area;
      outerIdx = i;
    }
  }
  if (outerIdx < 0 || outerArea < MIN_OBJECT_FRACTION * W * H) return null;

  const outerVec = own(new cv.MatVector());
  const outerContour = contours.get(outerIdx);
  outerVec.push_back(outerContour);
  const sil = own(new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(0)));
  cv.drawContours(sil, outerVec, 0, new cv.Scalar(255), -1);
  const outline = approxContour(cv, outerContour, 1.0);
  outerContour.delete();

  // Fori: regioni di sfondo racchiuse dalla silhouette (sil AND NOT fg).
  const notFg = own(new cv.Mat());
  cv.bitwise_not(fg, notFg);
  const inside = own(new cv.Mat());
  cv.bitwise_and(sil, notFg, inside);
  const labels = own(new cv.Mat());
  const stats = own(new cv.Mat());
  const cents = own(new cv.Mat());
  const nLabels = cv.connectedComponentsWithStats(inside, labels, stats, cents, 4, cv.CV_32S);

  const sData = sil.data;
  let silArea = 0;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (sData[y * W + x]) {
        silArea++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const silMask = Uint8Array.from(sData, (v) => (v ? 1 : 0));

  // Copie in array JS: nuove allocazioni WASM nel ciclo potrebbero invalidare le viste.
  const sd = Int32Array.from(stats.data32S);
  const cd = Float64Array.from(cents.data64F);
  const minHoleArea = Math.max(12, MIN_HOLE_FRACTION * silArea);
  const holes = [];
  for (let l = 1; l < nLabels; l++) {
    const area = sd[l * 5 + 4];
    if (area < minHoleArea) continue;
    const bw = sd[l * 5 + 2];
    const bh = sd[l * 5 + 3];
    const cx = cd[l * 2];
    const cy = cd[l * 2 + 1];
    const fill = area / (bw * bh);
    const aspect = bw / bh;
    // Un disco riempie π/4 del proprio riquadro e ha un riquadro quasi quadrato.
    const isCircle = Math.abs(aspect - 1) < 0.1 && Math.abs(fill - Math.PI / 4) < 0.07;
    if (isCircle) {
      holes.push({ type: 'circle', cx, cy, d: 2 * Math.sqrt(area / Math.PI) });
      continue;
    }
    const lm = own(new cv.Mat());
    cv.compare(labels, new cv.Scalar(l), lm, cv.CMP_EQ);
    const lvec = own(new cv.MatVector());
    const lh = own(new cv.Mat());
    cv.findContours(lm, lvec, lh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    if (lvec.size() === 0) continue;
    const lc = lvec.get(0);
    const pts = approxContour(cv, lc, 1.0);
    lc.delete();
    holes.push({ type: 'poly', cx, cy, area, pts });
  }

  const warnings = [];
  if (x0 <= roi.x || y0 <= roi.y || x1 >= roi.x + roi.w - 1 || y1 >= roi.y + roi.h - 1) {
    warnings.push("L'oggetto tocca il bordo dell'area selezionata: allarga il rettangolo.");
  }
  return {
    width: W,
    height: H,
    roi,
    sil: silMask,
    silArea,
    bbox: { x0, y0, x1, y1 },
    outline,
    holes,
    warnings,
  };
}

/**
 * Segmenta l'oggetto principale di `rgbaIn` (cv.Mat CV_8UC4).
 * @param {object} cv         istanza OpenCV.js inizializzata
 * @param {cv.Mat} rgbaIn     immagine (anche grande: viene ridotta a WORK_MAX_SIDE)
 * @param {{x,y,w,h}|null} roiIn  area (pixel dell'immagine) che contiene l'oggetto
 * @returns {{width,height,roi,sil,silArea,bbox,outline,holes,warnings,method}}
 */
export function segmentPhoto(cv, rgbaIn, roiIn = null) {
  const owned = [];
  const own = (m) => {
    owned.push(m);
    return m;
  };
  try {
    const W0 = rgbaIn.cols;
    const H0 = rgbaIn.rows;
    const k = Math.min(1, WORK_MAX_SIDE / Math.max(W0, H0));
    const W = Math.max(8, Math.round(W0 * k));
    const H = Math.max(8, Math.round(H0 * k));
    let work = rgbaIn;
    if (W !== W0 || H !== H0) {
      work = own(new cv.Mat());
      cv.resize(rgbaIn, work, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    }
    const roiFull = normalizeRoi(roiIn || defaultRoi(W0, H0), W0, H0);
    const roi = normalizeRoi(
      { x: (roiFull.x * W) / W0, y: (roiFull.y * H) / H0, w: (roiFull.w * W) / W0, h: (roiFull.h * H) / H0 },
      W,
      H,
    );

    const rgb = own(new cv.Mat());
    cv.cvtColor(work, rgb, cv.COLOR_RGBA2RGB);

    let method = 'color';
    let feats = null;
    const fgColor = colorMask(cv, rgb, W, H, roi, own);
    if (fgColor) feats = extractFeatures(cv, fgColor, W, H, roi, own);
    if (!feats) {
      method = 'grabcut';
      const fgGc = grabCutMask(cv, rgb, W, H, roi, own);
      feats = extractFeatures(cv, fgGc, W, H, roi, own);
    }
    if (!feats) {
      throw new SegmentationError(
        "Nessun oggetto rilevato. Prova a trascinare un rettangolo attorno all'oggetto, con sfondo più uniforme.",
      );
    }
    feats.method = method;
    feats.scale = W / W0; // pixel di lavoro per pixel originale
    return feats;
  } finally {
    for (const m of owned) m.delete();
  }
}
