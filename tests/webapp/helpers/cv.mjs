// Caricamento di OpenCV.js in Node (stesso build usato nel browser).
// Non si risolve una Promise con l'oggetto `cv`: è un thenable e ricadrebbe in loop.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function loadCv() {
  return new Promise((resolve) => {
    const mod = require('@techstark/opencv-js');
    if (typeof mod.Mat === 'function') return resolve({ cv: mod });
    mod.then((cv) => resolve({ cv }));
  });
}
