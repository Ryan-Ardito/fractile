// Pure Mandelbrot math, shared by the worker and by tests.
//
// Two per-pixel paths:
//  - direct: plain float64 escape-time iteration (levels shallow enough that
//    float64 can address individual pixels)
//  - perturbation: one reference orbit computed in BigInt fixed-point, then
//    per-pixel float64 delta iteration with rebasing (Zhuoran's method), which
//    keeps results correct with a single reference at any depth.

import { fixedToFloat, fixedMul } from "./fixedPoint";

const LN_2 = Math.log(2);

export const BAILOUT = 24;
const PERIODICITY_THRESHOLD = 1e-12;
const CYCLE_DETECTION_DELAY = 40;
const CYCLE_MEMORY_INTERVAL = 20;

export const isInCardioidOrBulb = (cx: number, cy: number): boolean => {
  const y2 = cy * cy;
  const q = (cx - 0.25) ** 2 + y2;
  const inCardioid = q * (q + (cx - 0.25)) < 0.25 * y2;
  const inBulb = (cx + 1.0) ** 2 + y2 < 0.0625;
  return inCardioid || inBulb;
};

// When a pixel runs out of iterations (-1 return), its mid-flight state is
// left here so the caller can resume it later with a bigger budget instead of
// recomputing from zero. ax/ay hold z (direct) or dz (perturbation); m is the
// perturbation orbit index. Single-threaded module state: rows are computed
// synchronously, so this never aliases between pixels.
export const pixelState = { ax: 0, ay: 0, m: 0 };

// Escape-time returns: smooth iteration count (> 0) on escape, 0 for
// confirmed interior (cycle detected), -1 when maxIters ran out without a
// verdict (resume state saved in pixelState). Pass n0/szx/szy from a previous
// -1 to continue that pixel where it stopped.
export const escapeTime = (
  cx: number,
  cy: number,
  maxIters: number,
  n0 = 0,
  szx = 0,
  szy = 0
): number => {
  let zx = szx;
  let zy = szy;
  let x2 = zx * zx;
  let y2 = zy * zy;
  let cycleX = 0;
  let cycleY = 0;

  for (let n = n0; n < maxIters; n++) {
    if (x2 + y2 > BAILOUT) {
      return n + 2 - Math.log(Math.log(x2 + y2)) / LN_2;
    }

    // Anchor also resets at n0: a resumed segment must never compare against
    // the zero-initialized anchor (a near-origin z would false-positive).
    if (n === n0 || n % CYCLE_MEMORY_INTERVAL === 0) {
      cycleX = zx;
      cycleY = zy;
    } else if (
      n >= CYCLE_DETECTION_DELAY &&
      Math.abs(zx - cycleX) < PERIODICITY_THRESHOLD &&
      Math.abs(zy - cycleY) < PERIODICITY_THRESHOLD
    ) {
      return 0;
    }

    zy = (zx + zx) * zy + cy;
    zx = x2 - y2 + cx;
    x2 = zx * zx;
    y2 = zy * zy;
  }

  pixelState.ax = zx;
  pixelState.ay = zy;
  pixelState.m = 0;
  return -1;
};

// Reference orbit in fixed-point, downsampled to float64 pairs. The generator
// yields every `chunk` iterations so the worker can breathe (progress checks,
// cancellation) during multi-second computations at extreme depth.
export function* referenceOrbit(
  cxFP: bigint,
  cyFP: bigint,
  bits: number,
  maxIter: number,
  chunk = 1024
): Generator<number, Float64Array, void> {
  const B = BigInt(bits);
  let zx = 0n;
  let zy = 0n;
  const orbit = new Float64Array((maxIter + 1) * 2);
  let n = 0;
  while (n <= maxIter) {
    const fx = fixedToFloat(zx, bits);
    const fy = fixedToFloat(zy, bits);
    orbit[2 * n] = fx;
    orbit[2 * n + 1] = fy;
    n++;
    if (fx * fx + fy * fy > BAILOUT) {
      break;
    }
    const nzx = fixedMul(zx, zx, B) - fixedMul(zy, zy, B) + cxFP;
    zy = fixedMul(zx << 1n, zy, B) + cyFP;
    zx = nzx;
    if (n % chunk === 0) {
      yield n;
    }
  }
  return orbit.slice(0, 2 * n);
}

// Delta iteration against a reference orbit. dz' = (2Z + dz)·dz + dc.
// Rebase (dz ← full z, restart at orbit index 0) when the orbit runs out or
// the full value falls below the delta — this is what makes a single
// reference valid for every pixel with no glitch heuristics.
// Pass n0/sdzx/sdzy/sm from a previous -1 (via pixelState) to resume.
export const perturbPixel = (
  dcx: number,
  dcy: number,
  orbit: Float64Array,
  maxIter: number,
  n0 = 0,
  sdzx = 0,
  sdzy = 0,
  sm = 0
): number => {
  const orbitLen = orbit.length >> 1;
  let dzx = sdzx;
  let dzy = sdzy;
  let m = sm;
  let cycleX = 0;
  let cycleY = 0;

  for (let n = n0; n < maxIter; n++) {
    let refX = orbit[2 * m];
    let refY = orbit[2 * m + 1];
    const zx = refX + dzx;
    const zy = refY + dzy;
    const zMag = zx * zx + zy * zy;
    if (zMag > BAILOUT) {
      return n + 2 - Math.log(Math.log(zMag)) / LN_2;
    }

    // Anchor also resets at n0: a resumed segment must never compare against
    // the zero-initialized anchor (a near-origin z would false-positive).
    if (n === n0 || n % CYCLE_MEMORY_INTERVAL === 0) {
      cycleX = zx;
      cycleY = zy;
    } else if (
      n >= CYCLE_DETECTION_DELAY &&
      Math.abs(zx - cycleX) < PERIODICITY_THRESHOLD &&
      Math.abs(zy - cycleY) < PERIODICITY_THRESHOLD
    ) {
      return 0;
    }

    if (m + 1 >= orbitLen || zMag < dzx * dzx + dzy * dzy) {
      dzx = zx;
      dzy = zy;
      m = 0;
      refX = 0;
      refY = 0;
    }

    const sx = 2 * refX + dzx;
    const sy = 2 * refY + dzy;
    const ndzx = sx * dzx - sy * dzy + dcx;
    dzy = sx * dzy + sy * dzx + dcy;
    dzx = ndzx;
    m++;
  }

  pixelState.ax = dzx;
  pixelState.ay = dzy;
  pixelState.m = m;
  return -1;
};

// Row-band tile computation (the worker processes bands so it can yield for
// cancellation between them). Pixels sample at cell centers, which keeps the
// sample grid off the real axis — the old "black real line" artifact was rows
// landing exactly on im(c) = 0.
//
// Both row functions return the number of ran-out pixels (hit maxIter with no
// interior/escape verdict); those pixels are written as 0. When an
// UnresolvedBuf is supplied, their mid-flight state is recorded so the caller
// can resume just those pixels with a larger budget — adaptive iterations
// without recomputing pixels that already resolved.

export type UnresolvedBuf = {
  count: number;
  idx: Int32Array;
  ax: Float64Array;
  ay: Float64Array;
  m: Int32Array;
};

export const makeUnresolvedBuf = (capacity: number): UnresolvedBuf => ({
  count: 0,
  idx: new Int32Array(capacity),
  ax: new Float64Array(capacity),
  ay: new Float64Array(capacity),
  m: new Int32Array(capacity),
});

const recordUnresolved = (un: UnresolvedBuf, idx: number): void => {
  un.idx[un.count] = idx;
  un.ax[un.count] = pixelState.ax;
  un.ay[un.count] = pixelState.ay;
  un.m[un.count] = pixelState.m;
  un.count++;
};

export const directRows = (
  level: number,
  tx: number,
  ty: number,
  size: number,
  maxIter: number,
  rowStart: number,
  rowEnd: number,
  out: Float32Array,
  un?: UnresolvedBuf
): number => {
  const tileW = 16 * 2 ** -level;
  const step = tileW / size;
  const x0 = tx * tileW - 8;
  const y0 = ty * tileW - 8;
  let ranOut = 0;
  for (let py = rowStart; py < rowEnd; py++) {
    const cy = y0 + (py + 0.5) * step;
    const rowIdx = py * size;
    for (let px = 0; px < size; px++) {
      const cx = x0 + (px + 0.5) * step;
      const v = isInCardioidOrBulb(cx, cy)
        ? 0
        : escapeTime(cx, cy, maxIter);
      if (v < 0) {
        ranOut++;
        if (un) recordUnresolved(un, rowIdx + px);
      }
      out[rowIdx + px] = v > 0 ? v : 0;
    }
  }
  return ranOut;
};

export const perturbRows = (
  dcx0: number,
  dcy0: number,
  step: number,
  size: number,
  maxIter: number,
  orbit: Float64Array,
  rowStart: number,
  rowEnd: number,
  out: Float32Array,
  un?: UnresolvedBuf
): number => {
  let ranOut = 0;
  for (let py = rowStart; py < rowEnd; py++) {
    const dcy = dcy0 + (py + 0.5) * step;
    const rowIdx = py * size;
    for (let px = 0; px < size; px++) {
      const dcx = dcx0 + (px + 0.5) * step;
      const v = perturbPixel(dcx, dcy, orbit, maxIter);
      if (v < 0) {
        ranOut++;
        if (un) recordUnresolved(un, rowIdx + px);
      }
      out[rowIdx + px] = v > 0 ? v : 0;
    }
  }
  return ranOut;
};
