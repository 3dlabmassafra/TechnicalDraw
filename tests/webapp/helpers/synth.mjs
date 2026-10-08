// Foto sintetiche con geometria nota (verità a terra in mm).
// Un pixel (i,j) corrisponde a X = (i+0.5-ox)/ppm, V = (oy-(j+0.5))/ppm.

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rende una scena: `inside(X,V)` decide l'oggetto (fori esclusi). */
export function renderScene({ w, h, ppm, ox, oy, inside, shadow = false, seed = 7, bg = [226, 224, 218], fg = [72, 104, 150] }) {
  const rand = rng(seed);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const truth = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const X = (i + 0.5 - ox) / ppm;
      const V = (oy - (j + 0.5)) / ppm;
      const obj = inside(X, V);
      truth[j * w + i] = obj ? 1 : 0;
      // ombra morbida sotto l'oggetto (test di robustezza della segmentazione)
      let shade = 1;
      if (shadow && !obj) {
        const dx = (X - 0) / 1;
        const dV = V - -3;
        if (Math.abs(dx) < 90 && dV < 0 && dV > -6) shade = 0.82;
      }
      const base = obj ? fg : bg.map((c) => c * (1 - 0.06 * (j / h)));
      const n = () => (rand() - 0.5) * 10;
      const p = (j * w + i) * 4;
      rgba[p] = Math.max(0, Math.min(255, base[0] * shade + n()));
      rgba[p + 1] = Math.max(0, Math.min(255, base[1] * shade + n()));
      rgba[p + 2] = Math.max(0, Math.min(255, base[2] * shade + n()));
      rgba[p + 3] = 255;
    }
  }
  return { w, h, rgba, truth };
}

/** Staffa a L (profilo XZ) con due fori: esempio di estruso. */
export function bracketScene(opts = {}) {
  const outline = [[0, 0], [60, 0], [60, 10], [12, 10], [12, 40], [0, 40]];
  const holes = [
    { x: 45, z: 5, d: 6 },
    { x: 6, z: 30, d: 6 },
  ];
  const ppm = 4;
  const inside = (X, Z) =>
    pointInPoly(X, Z, outline) && !holes.some((o) => Math.hypot(X - o.x, Z - o.z) < o.d / 2);
  return { ...renderScene({ w: 800, h: 600, ppm, ox: 280, oy: 480, inside, ...opts }), outline, holes, dims: { W: 60, H: 40 } };
}

/** Albero a gradini (profilo di rotazione), H = 80, Ø max = 30. */
export function shaftScene(opts = {}) {
  const steps = [
    [0, 20, 15],
    [20, 60, 8],
    [60, 80, 12],
  ];
  const ppm = 4;
  const rAt = (V) => {
    for (const [z0, z1, r] of steps) if (V >= z0 && V <= z1) return r;
    return -1;
  };
  const inside = (X, V) => {
    const r = rAt(V);
    return r > 0 && Math.abs(X) <= r;
  };
  return { ...renderScene({ w: 800, h: 600, ppm, ox: 400, oy: 500, inside, ...opts }), steps, dims: { H: 80, D: 30 } };
}

/** Piastra vista dall'alto (X×Y = 120×60) con 4 fori passanti. */
export function plateScene(opts = {}) {
  const outline = [[0, 0], [120, 0], [120, 60], [0, 60]];
  const holes = [
    { x: 15, y: 15, d: 6 },
    { x: 105, y: 15, d: 6 },
    { x: 15, y: 45, d: 6 },
    { x: 105, y: 45, d: 6 },
  ];
  const ppm = 4;
  const inside = (X, Y) =>
    pointInPoly(X, Y, outline) && !holes.some((o) => Math.hypot(X - o.x, Y - o.y) < o.d / 2);
  return { ...renderScene({ w: 800, h: 600, ppm, ox: 160, oy: 420, inside, ...opts }), outline, holes, dims: { W: 120, L: 60 } };
}

/** Piastra 120 × 60 con un'asola passante 28 × 8 mm (centro 50, 30) e un foro Ø 6 (100, 45). */
export function slotScene(opts = {}) {
  const outline = [[0, 0], [120, 0], [120, 60], [0, 60]];
  const ppm = 4;
  const distToSlot = (X, Y) => Math.hypot(X - Math.max(40, Math.min(60, X)), Y - 30); // segmento 40–60 con raggio 4
  const inside = (X, Y) => pointInPoly(X, Y, outline) && distToSlot(X, Y) > 4 && Math.hypot(X - 100, Y - 45) > 3;
  return { ...renderScene({ w: 800, h: 600, ppm, ox: 160, oy: 420, inside, ...opts }), outline, dims: { W: 120, L: 60 } };
}
