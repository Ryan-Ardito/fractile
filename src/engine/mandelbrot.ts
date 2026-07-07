// Pure Mandelbrot math, shared by the worker and by tests.
//
// Two per-pixel paths:
//  - direct: plain float64 escape-time iteration (levels shallow enough that
//    float64 can address individual pixels)
//  - perturbation: one reference orbit computed in BigInt fixed-point, then
//    per-pixel float64 delta iteration with rebasing (Zhuoran's method), which
//    keeps results correct with a single reference at any depth.

import { BLA_LMIN, BLA_LMIN_LOG2, BlaTable } from "./bla";
import { fixedToFloat, fixedMul } from "./fixedPoint";

// Band bounds for the deep path's scaled mantissas: w is renormalized into
// [2^-32, 2^32], so the exponent s tracks log2|dz| to within ~32 bits.
const W_HI = 4294967296; // 2^32
const W_LO = 2.3283064365386963e-10; // 2^-32

const LN_2 = Math.log(2);

export const BAILOUT = 24;

// Interior detection is a hyperbolicity test: track the squared magnitude of
// the accumulated orbit derivative e = ∏ 2·z_i (skipping z_0 = 0). A point is
// interior iff its orbit is attracted to a cycle with multiplier |μ| < 1, in
// which case |e|² decays geometrically per period; exterior points shadow
// cycles with |μ| ≥ 1 and don't decay. Because |e|² also dips arbitrarily low
// WITHIN a period (cycles near minibrots pass close to z = 0), the verdict
// compares the RUNNING MAXIMUM over doubling windows — once a window spans a
// full period, interior maxima collapse and exterior maxima never do. Unlike
// anchor-comparison periodicity checks (whose absolute epsilon falsely fires
// on near-cycle lingering once features shrink below it — black flames around
// deep minibrots), this is scale-independent at any depth and detects
// attracting cycles of any period.
const INTERIOR_E2 = 1e-12;
const INTERIOR_FIRST_CHECK = 64;
const E2_CLAMP = 1e60;

// Reference-unsuitability (dc-starvation) detection. Perturbation is only
// meaningful while the pixel's dc stays numerically significant in
// dz' = (2Z + dz)·dz + dc. When the reference orbit ESCAPES but the pixel
// stays bounded (a minibrot under an exterior reference), rebasing leaves
// |dz| at O(1) — once |dz| exceeds |dc| by ~2^49, plain steps apply dc
// within a few ulps of zero effect, and BLA skips taken at such dz sit at
// the edge of their validity radii where linearization error accumulates
// systematically across near-parabolic lingering (verified: a BLA table
// from an escaped reference certifies truly-escaping fringe pixels as
// "interior"). A pixel in that regime cannot be TRUSTED to certify
// interior, so an interior verdict from it returns BAD_REF: recompute
// against a reference whose own orbit stays near the pixel's dynamics (the
// pool re-references at such a pixel). ONLY the interior verdict is
// poisoned. Escapes are chaos-class under any reference, and unresolved
// pixels (budget exhausted, parked on a short orbit) simply park and
// escalate — a delta legitimately dwarfs its dc after enough growth, so
// treating "starved at some point" as fatal blackened every slow-escaping
// filament pixel (the z152 streak regression).
export const BAD_REF = -2;
// Stored escape-time sentinel for a CONFIRMED interior pixel (attracting-cycle
// verdict). The output buffer overloads its values: escaped pixels are > 0,
// not-yet-computed / ran-out / bad-ref pixels are 0, and confirmed interior is
// this distinct negative marker. Keeping interior separate from 0 lets the
// palette shader paint it opaque black immediately on a progress stand-in
// (uPreview) instead of leaving it transparent — so a minibrot interior no
// longer shows the stretched parent tile through it until the tile finishes.
export const INTERIOR = -1;
// An interior verdict is distrusted only after MANY near-edge skips: the
// verified corruption (escaped-ref false interiors) lingers near-parabolically
// through hundreds of skips within 2^16 of their validity radii, while a
// legitimate pixel diverging from the reference toward its own attracting
// cycle transits that band in a few dozen. Measured: false interiors under
// an escaped z75 reference take 62-70 loose skips; legitimate interiors at
// a z122 minibrot max out at 47 (median 0). (Boolean flagging blackened
// cross-attractor interiors and caused reference flip-flop churn.)
const LOOSE_SKIP_TOLERANCE = 52;
const LOOSE_EDGE = 2 ** -16;

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
// perturbation orbit index; n is the iteration the pixel actually reached
// (below the budget when a truncated reference parked it early); e2 is the
// interior-detection derivative magnitude.
// Single-threaded module state: rows are computed synchronously, so this
// never aliases between pixels.
export const pixelState = { ax: 0, ay: 0, s: 0, m: 0, n: 0, e2: 1 };
// Diagnostic: loose-skip count of the last bounded verdict (see BAD_REF).
export const lastLooseSkips = { v: 0 };

// Escape-time returns: smooth iteration count (> 0) on escape, 0 for
// confirmed interior (attracting-cycle test), -1 when maxIters ran out
// without a verdict (resume state saved in pixelState). Pass state from a
// previous -1 to continue that pixel where it stopped.
export const escapeTime = (
  cx: number,
  cy: number,
  maxIters: number,
  n0 = 0,
  szx = 0,
  szy = 0,
  se2 = 1
): number => {
  // The unary + on parameter-seeded loop floats is load-bearing: without an
  // explicit ToNumber, V8 gives these loop-carried variables a boxed
  // representation and the whole loop runs ~2.4x slower (heap-number
  // allocation per iteration). Measured on the perturbation loop, node 24.
  let zx = +szx;
  let zy = +szy;
  let x2 = zx * zx;
  let y2 = zy * zy;
  let e2 = +se2;
  let e2Max = 0;
  let nextCheck = INTERIOR_FIRST_CHECK;
  while (nextCheck <= n0) nextCheck *= 2;

  for (let n = n0; n < maxIters; n++) {
    const zMag = x2 + y2;
    if (zMag > BAILOUT) {
      return n + 2 - Math.log(Math.log(zMag)) / LN_2;
    }

    if (n !== 0) {
      e2 *= 4 * zMag;
      if (e2 > E2_CLAMP) e2 = E2_CLAMP;
      if (e2 > e2Max) e2Max = e2;
      if (n >= nextCheck) {
        if (e2Max < INTERIOR_E2) return 0;
        e2Max = 0;
        while (nextCheck <= n) nextCheck *= 2;
      }
    }

    zy = (zx + zx) * zy + cy;
    zx = x2 - y2 + cx;
    x2 = zx * zx;
    y2 = zy * zy;
  }

  pixelState.ax = zx;
  pixelState.ay = zy;
  pixelState.s = 0;
  pixelState.m = 0;
  pixelState.n = maxIters;
  pixelState.e2 = e2;
  return -1;
};

// Resumable state of a budget-truncated reference computation: `n` entries
// are written and (zx, zy) is z_n, the next value to write — exactly the
// loop-top invariant below, so continuing is bit-identical to a fresh run.
export type RefResume = {
  zx: bigint;
  zy: bigint;
  n: number;
  orbit: Float64Array;
};

export type RefResult = {
  orbit: Float64Array;
  zx: bigint;
  zy: bigint;
  n: number;
  escaped: boolean;
};

// Reference orbit in fixed-point, downsampled to float64 pairs. The generator
// yields every `chunk` iterations so the worker can breathe (progress checks,
// cancellation) during multi-second computations at extreme depth. A resume
// state (from a previous truncated run of the SAME center/bits) continues the
// BigInt iteration instead of re-paying the whole prefix — extensions after
// ref-short signals would otherwise recompute everything from z=0.
export function* referenceOrbit(
  cxFP: bigint,
  cyFP: bigint,
  bits: number,
  maxIter: number,
  chunk = 1024,
  resume?: RefResume
): Generator<number, RefResult, void> {
  const B = BigInt(bits);
  let zx = resume ? resume.zx : 0n;
  let zy = resume ? resume.zy : 0n;
  const orbit = new Float64Array((maxIter + 1) * 2);
  let n = 0;
  if (resume) {
    const prefix = Math.min(resume.orbit.length, 2 * resume.n, orbit.length);
    orbit.set(resume.orbit.subarray(0, prefix));
    n = prefix >> 1;
  }
  let escaped = false;
  while (n <= maxIter) {
    const fx = fixedToFloat(zx, bits);
    const fy = fixedToFloat(zy, bits);
    orbit[2 * n] = fx;
    orbit[2 * n + 1] = fy;
    n++;
    if (fx * fx + fy * fy > BAILOUT) {
      escaped = true;
      break;
    }
    const nzx = fixedMul(zx, zx, B) - fixedMul(zy, zy, B) + cxFP;
    zy = fixedMul(zx << 1n, zy, B) + cyFP;
    zx = nzx;
    if (n % chunk === 0) {
      yield n;
    }
  }
  return { orbit: orbit.slice(0, 2 * n), zx, zy, n, escaped };
}

// Delta iteration against a reference orbit. dz' = (2Z + dz)·dz + dc.
// Rebase (dz ← full z, restart at orbit index 0) when the orbit runs out or
// the full value falls below the delta — this is what makes a single
// reference valid for every pixel's ESCAPING dynamics with no glitch
// heuristics. Bounded pixels additionally need the reference to keep dz
// small so dc stays significant; a bounded verdict from a dc-starved pixel
// returns BAD_REF instead (see above).
// Pass n0/sdzx/sdzy/sm from a previous -1 (via pixelState) to resume.
// With a BLA table, block-aligned stretches where the delta is inside the
// entry's validity radius are skipped in one linear application.
export const perturbPixel = (
  dcx: number,
  dcy: number,
  orbit: Float64Array,
  maxIter: number,
  n0 = 0,
  sdzx = 0,
  sdzy = 0,
  sm = 0,
  bla: BlaTable | null = null,
  se2 = 1
): number => {
  const orbitLen = orbit.length >> 1;
  // Wrapping at the orbit end is only sound when the orbit ended by ESCAPE:
  // the pixel is then itself at escape scale and leaves within a few plain
  // steps. Wrapping a budget-truncated orbit would turn the delta into a
  // full-magnitude value mid-flight — plain float64 iteration, which is
  // garbage at depth. Truncation instead parks the pixel as unresolved; its
  // saved (dz, m) state stays valid against a longer orbit of the same
  // center, so it resumes exactly once the reference is extended.
  const ex = orbit[2 * (orbitLen - 1)];
  const ey = orbit[2 * (orbitLen - 1) + 1];
  const orbitEscaped = ex * ex + ey * ey > BAILOUT;
  const dcMag = Math.abs(dcx) + Math.abs(dcy);
  let looseSkips = 0;
  // + coercions: see escapeTime — unboxes the loop-carried floats (~2.4x).
  let dzx = +sdzx;
  let dzy = +sdzy;
  let m = sm;
  let e2 = +se2;
  let e2Max = 0;
  let nextCheck = INTERIOR_FIRST_CHECK;
  while (nextCheck <= n0) nextCheck *= 2;

  for (let n = n0; n < maxIter; n++) {
    let refX = orbit[2 * m];
    let refY = orbit[2 * m + 1];
    const zx = refX + dzx;
    const zy = refY + dzy;
    const zMag = zx * zx + zy * zy;
    if (zMag > BAILOUT) {
      return n + 2 - Math.log(Math.log(zMag)) / LN_2;
    }

    const dzMag2 = dzx * dzx + dzy * dzy;

    if (n !== 0) {
      e2 *= 4 * zMag;
      if (e2 > E2_CLAMP) e2 = E2_CLAMP;
      if (e2 > e2Max) e2Max = e2;
      if (n >= nextCheck) {
        if (e2Max < INTERIOR_E2) {
          lastLooseSkips.v = looseSkips;
          pixelState.n = n; // fire point — callers may confirm by replay
          return looseSkips > LOOSE_SKIP_TOLERANCE ? BAD_REF : 0;
        }
        e2Max = 0;
        while (nextCheck <= n) nextCheck *= 2;
      }
    }

    if (m + 1 >= orbitLen) {
      if (!orbitEscaped) {
        // Reference too short (truncated, not escaped): park unresolved.
        pixelState.ax = dzx;
        pixelState.ay = dzy;
        pixelState.s = 0;
        pixelState.m = m;
        pixelState.n = n;
        pixelState.e2 = e2;
        return -1;
      }
      dzx = zx;
      dzy = zy;
      m = 0;
      refX = 0;
      refY = 0;
    } else if (zMag < dzMag2) {
      dzx = zx;
      dzy = zy;
      m = 0;
      refX = 0;
      refY = 0;
    }

    // Try the largest block-aligned BLA skip that is valid here. |dz| is
    // bounded with |x|+|y| (not a squared magnitude, which underflows at
    // extreme depth). A valid skip cannot contain an escape or a rebase, so
    // the checks above stay sound.
    if (bla !== null && (m & (BLA_LMIN - 1)) === 0) {
      const levels = bla.levels;
      const i = m >> BLA_LMIN_LOG2;
      const dzMag = Math.abs(dzx) + Math.abs(dzy);
      let skipped = false;
      for (let k = levels.length - 1; k >= 0; k--) {
        if ((i & ((1 << k) - 1)) !== 0) continue;
        const lv = levels[k];
        const j = i >> k;
        // Strict comparisons: a zero radius is invalid for any input,
        // including an exactly-zero delta.
        if (
          j >= lv.rz.length ||
          !(dzMag < lv.rz[j]) ||
          !(dcMag < lv.rc[j]) ||
          n + lv.len > maxIter
        ) {
          continue;
        }
        // Skips near the radius edge accumulate linearization error across
        // near-parabolic lingering — fine for escapes, corrupting for
        // bounded verdicts once there are many of them. (Verified: an
        // escaped-reference table certifies truly-escaping fringe pixels
        // "interior" until radii shrink by 2^16.)
        if (!(dzMag < lv.rz[j] * LOOSE_EDGE)) looseSkips++;
        const axv = lv.ax[j];
        const ayv = lv.ay[j];
        const bxv = lv.bx[j];
        const byv = lv.by[j];
        const nx = axv * dzx - ayv * dzy + bxv * dcx - byv * dcy;
        dzy = axv * dzy + ayv * dzx + bxv * dcy + byv * dcx;
        dzx = nx;
        // The block's A is the accumulated derivative across it (to within
        // the validity tolerance), so the interior test rides along free —
        // including the block's INTERNAL peak, without which within-period
        // e2 maxima hide inside skips and lingerers fire false interiors.
        const pkv = e2 * lv.pk[j];
        if (pkv > e2Max) e2Max = pkv;
        e2 *= axv * axv + ayv * ayv;
        if (e2 > E2_CLAMP) e2 = E2_CLAMP;
        if (e2 > e2Max) e2Max = e2;
        m += lv.len;
        n += lv.len - 1; // the loop increment supplies the last one
        skipped = true;
        break;
      }
      if (skipped) continue;
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
  pixelState.s = 0;
  pixelState.m = m;
  pixelState.n = maxIter;
  pixelState.e2 = e2;
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
  // Deep-path delta exponent (dz = (ax, ay)·2^s); 0 on the float64 paths.
  s: Int32Array;
  m: Int32Array;
  n: Int32Array;
  e2: Float64Array;
};

// Interior-confirmation state for a row pass. BLA-accumulated trajectory
// error over long near-parabolic lingering can pull a truly-ESCAPING pixel
// onto the attracting side, firing a false interior verdict at skips well
// inside their validity radii (verified: plain escapes @66-72k where BLA
// certifies interior — no radius margin catches accumulation-over-time). An
// interior verdict fired at n <= CONFIRM_MAX_N is therefore confirmed by a
// PLAIN replay (~ms); a flip to escape is used directly (that's the true
// detail). Confirmation runs at full density until a streak of agreements,
// then samples 1-in-64 — inside a contiguous false-interior halo every flip
// resets the streak, so correction stays at full density exactly where it is
// needed, while true-interior bodies pay only the sampled rate. Deep fires
// (millions of iterations) skip confirmation: their display is black either
// way, and replay there would cost seconds per pixel. Deterministic — cost
// is a function of tile content only.
export type ConfirmBuf = { streak: number };
const CONFIRM_MAX_N = 1 << 18;
const CONFIRM_STREAK = 8;
const CONFIRM_SAMPLE_MASK = 63;

export const confirmInterior = (
  conf: ConfirmBuf,
  idx: number,
  fireN: number,
  replay: (budget: number) => number,
  maxIter: number
): number => {
  if (
    fireN > CONFIRM_MAX_N ||
    (conf.streak >= CONFIRM_STREAK && (idx & CONFIRM_SAMPLE_MASK) !== 0)
  ) {
    return 0;
  }
  const pv = replay(Math.min(maxIter, fireN * 2 + 1024));
  if (pv === 0) {
    conf.streak++;
    return 0;
  }
  conf.streak = 0;
  return pv; // escape (true detail), unresolved, or BAD_REF
};

// Bad-reference report for a row pass: how many pixels returned BAD_REF and
// the dc of the first one — the natural center for a rescue reference (its
// orbit is bounded, so it stays near the whole region's dynamics). On the
// deep path dcx/dcy are mantissas at scale 2^e; e is 0 on the float64 path.
export type BadRefBuf = { count: number; dcx: number; dcy: number; e: number };

export const makeUnresolvedBuf = (capacity: number): UnresolvedBuf => ({
  count: 0,
  idx: new Int32Array(capacity),
  ax: new Float64Array(capacity),
  ay: new Float64Array(capacity),
  s: new Int32Array(capacity),
  m: new Int32Array(capacity),
  n: new Int32Array(capacity),
  e2: new Float64Array(capacity),
});

const recordUnresolved = (un: UnresolvedBuf, idx: number): void => {
  un.idx[un.count] = idx;
  un.ax[un.count] = pixelState.ax;
  un.ay[un.count] = pixelState.ay;
  un.s[un.count] = pixelState.s;
  un.m[un.count] = pixelState.m;
  un.n[un.count] = pixelState.n;
  un.e2[un.count] = pixelState.e2;
  un.count++;
};

export const directRows = (
  x0: number,
  y0: number,
  step: number,
  size: number,
  maxIter: number,
  rowStart: number,
  rowEnd: number,
  out: Float32Array,
  un?: UnresolvedBuf
): number => {
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
      out[rowIdx + px] = v > 0 ? v : v === 0 ? INTERIOR : 0;
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
  un?: UnresolvedBuf,
  bla: BlaTable | null = null,
  bad?: BadRefBuf,
  conf?: ConfirmBuf
): number => {
  let ranOut = 0;
  for (let py = rowStart; py < rowEnd; py++) {
    const dcy = dcy0 + (py + 0.5) * step;
    const rowIdx = py * size;
    for (let px = 0; px < size; px++) {
      const dcx = dcx0 + (px + 0.5) * step;
      let v = perturbPixel(dcx, dcy, orbit, maxIter, 0, 0, 0, 0, bla);
      if (v === 0 && bla !== null && conf) {
        v = confirmInterior(
          conf, rowIdx + px, pixelState.n,
          (budget) => perturbPixel(dcx, dcy, orbit, budget),
          maxIter
        );
      }
      if (v === BAD_REF) {
        if (bad) {
          if (bad.count === 0) {
            bad.dcx = dcx;
            bad.dcy = dcy;
          }
          bad.count++;
        }
      } else if (v < 0) {
        ranOut++;
        if (un) recordUnresolved(un, rowIdx + px);
      }
      out[rowIdx + px] = v > 0 ? v : v === 0 ? INTERIOR : 0;
    }
  }
  return ranOut;
};

// --- extended-exponent (floatexp) deep path: arbitrary zoom ---
//
// Past zoom ~940, dz and dc underflow float64. Here the delta carries an
// explicit power-of-two exponent: dz = (wx, wy)·2^s with the mantissa pair
// renormalized into [2^-32, 2^32], and dc = (ux, uy)·2^dcE with mantissas in
// sample-pitch units (so dcE = -(level+4) and |u| is small). The reference
// orbit needs no change — its values are O(1) — and z = Z + dz is formed in
// plain float64, where an unrepresentably small dz correctly contributes
// nothing. Every structural rule of perturbPixel (rebasing, wrap-at-escape
// only, e2 interior windows, dc-starvation/BAD_REF, BLA validity) carries
// over; only the delta arithmetic is scaled.
export const perturbPixelDeep = (
  ux: number,
  uy: number,
  dcE: number,
  orbit: Float64Array,
  maxIter: number,
  n0 = 0,
  swx = 0,
  swy = 0,
  ss = 0,
  sm = 0,
  bla: BlaTable | null = null,
  se2 = 1
): number => {
  const orbitLen = orbit.length >> 1;
  const ex = orbit[2 * (orbitLen - 1)];
  const ey = orbit[2 * (orbitLen - 1) + 1];
  const orbitEscaped = ex * ex + ey * ey > BAILOUT;
  const dcMag1 = Math.abs(ux) + Math.abs(uy);
  // |dc| as float64 — 0 when genuinely below the float64 floor, which is the
  // correct value for the BLA rc comparisons (the bound holds a fortiori).
  const dcMagF = dcMag1 * 2 ** dcE;
  let looseSkips = 0;

  // + coercions: see escapeTime — unboxes the loop-carried floats (~2.4x).
  let wx = +swx;
  let wy = +swy;
  let s = ss;
  let p2s = 2 ** s;
  // dc mantissa rescaled to the CURRENT dz scale: u·fDc adds dc in one
  // multiply per step. Recomputed (never incrementally scaled) at every
  // s-change site so an underflowed factor becomes representable again as
  // s falls back toward dcE.
  let fDc = 2 ** (dcE - s);
  let m = sm;
  let e2 = +se2;
  let e2Max = 0;
  let nextCheck = INTERIOR_FIRST_CHECK;
  while (nextCheck <= n0) nextCheck *= 2;

  for (let n = n0; n < maxIter; n++) {
    let refX = orbit[2 * m];
    let refY = orbit[2 * m + 1];
    // dz in float64 (0 when unrepresentably small), computed ONCE per
    // iteration and reassigned only in the rare rebase branches.
    let dzxF = wx * p2s;
    let dzyF = wy * p2s;
    const zx = refX + dzxF;
    const zy = refY + dzyF;
    const zMag = zx * zx + zy * zy;
    if (zMag > BAILOUT) {
      return n + 2 - Math.log(Math.log(zMag)) / LN_2;
    }

    if (n !== 0) {
      e2 *= 4 * zMag;
      if (e2 > E2_CLAMP) e2 = E2_CLAMP;
      if (e2 > e2Max) e2Max = e2;
      if (n >= nextCheck) {
        if (e2Max < INTERIOR_E2) {
          pixelState.n = n; // fire point — callers may confirm by replay
          return looseSkips > LOOSE_SKIP_TOLERANCE ? BAD_REF : 0;
        }
        e2Max = 0;
        while (nextCheck <= n) nextCheck *= 2;
      }
    }

    // Rebase / wrap: the float64 image of dz gives exactly the right
    // comparisons — an invisible delta never outweighs z, and a wrap only
    // happens once the delta is O(z) anyway.
    const dzMagF2 = dzxF * dzxF + dzyF * dzyF;
    if (m + 1 >= orbitLen) {
      if (!orbitEscaped) {
        pixelState.ax = wx;
        pixelState.ay = wy;
        pixelState.s = s;
        pixelState.m = m;
        pixelState.n = n;
        pixelState.e2 = e2;
        return -1;
      }
      wx = zx;
      wy = zy;
      s = 0;
      p2s = 1;
      fDc = 2 ** dcE;
      dzxF = zx;
      dzyF = zy;
      refX = 0;
      refY = 0;
    } else if (zMag < dzMagF2) {
      wx = zx;
      wy = zy;
      s = 0;
      p2s = 1;
      fDc = 2 ** dcE;
      dzxF = zx;
      dzyF = zy;
      refX = 0;
      refY = 0;
    }

    if (bla !== null && (m & (BLA_LMIN - 1)) === 0) {
      const levels = bla.levels;
      const i = m >> BLA_LMIN_LOG2;
      // |dz| in float64: 0 when far below the floor, which correctly passes
      // every radius — the delta really is that small.
      const dzMag = (Math.abs(wx) + Math.abs(wy)) * p2s;
      let skipped = false;
      for (let k = levels.length - 1; k >= 0; k--) {
        if ((i & ((1 << k) - 1)) !== 0) continue;
        const lv = levels[k];
        const j = i >> k;
        if (
          j >= lv.rz.length ||
          !(dzMag < lv.rz[j]) ||
          !(dcMagF < lv.rc[j]) ||
          n + lv.len > maxIter
        ) {
          continue;
        }
        const axv = lv.ax[j];
        const ayv = lv.ay[j];
        const bxv = lv.bx[j];
        const byv = lv.by[j];
        // Coefficients near the float64 ceiling could overflow the scaled
        // mantissas; such blocks live on escape ramps and are skippable.
        if (
          !(Math.abs(axv) + Math.abs(ayv) < 1e150) ||
          !(Math.abs(bxv) + Math.abs(byv) < 1e150)
        ) {
          continue;
        }
        // Same trust rule as the float64 path.
        if (dzMag > 0 && !(dzMag < lv.rz[j] * LOOSE_EDGE)) looseSkips++;
        // dz' = A·dz + B·dc, merged at the coarser scale.
        const pxm = axv * wx - ayv * wy;
        const pym = axv * wy + ayv * wx;
        const qxm = bxv * ux - byv * uy;
        const qym = bxv * uy + byv * ux;
        if (s >= dcE) {
          wx = pxm + qxm * fDc;
          wy = pym + qym * fDc;
        } else {
          const f = 2 ** (s - dcE);
          wx = pxm * f + qxm;
          wy = pym * f + qym;
          s = dcE;
        }
        const pkv = e2 * lv.pk[j];
        if (pkv > e2Max) e2Max = pkv;
        e2 *= axv * axv + ayv * ayv;
        if (e2 > E2_CLAMP) e2 = E2_CLAMP;
        if (e2 > e2Max) e2Max = e2;
        m += lv.len;
        n += lv.len - 1;
        skipped = true;
        break;
      }
      if (skipped) {
        // A applied in one go can move the mantissa far out of band.
        const wm = Math.abs(wx) + Math.abs(wy);
        if (wm > 0 && (wm > W_HI || wm < W_LO)) {
          const k = Math.round(Math.log2(wm));
          const g = 2 ** -k;
          wx *= g;
          wy *= g;
          s += k;
        }
        p2s = 2 ** s;
        fDc = 2 ** (dcE - s);
        continue;
      }
    }

    // Plain step: dz' = (2Z + dz)·dz + dc = 2^s·((2Z + dz)·w) + 2^dcE·u.
    const sx = 2 * refX + dzxF;
    const sy = 2 * refY + dzyF;
    const pxm = sx * wx - sy * wy;
    const pym = sx * wy + sy * wx;
    if (s >= dcE) {
      wx = pxm + ux * fDc;
      wy = pym + uy * fDc;
    } else {
      const f = 2 ** (s - dcE);
      wx = pxm * f + ux;
      wy = pym * f + uy;
      s = dcE;
      p2s = 2 ** s;
      fDc = 1;
    }
    m++;
    // Growth per plain step is bounded (|2Z + dz| < 2·bailout), so one band
    // shift keeps the mantissa in range.
    const wm = Math.abs(wx) + Math.abs(wy);
    if (wm > W_HI) {
      wx *= W_LO;
      wy *= W_LO;
      s += 32;
      p2s = 2 ** s;
      fDc = 2 ** (dcE - s);
    } else if (wm !== 0 && wm < W_LO) {
      wx *= W_HI;
      wy *= W_HI;
      s -= 32;
      p2s = 2 ** s;
      fDc = 2 ** (dcE - s);
    }
  }

  pixelState.ax = wx;
  pixelState.ay = wy;
  pixelState.s = s;
  pixelState.m = m;
  pixelState.n = maxIter;
  pixelState.e2 = e2;
  return -1;
};

// Deep-path row pass: per-pixel dc mantissas are u0 + (px + 0.5) in
// sample-pitch units at scale 2^dcE (dcE = -(level + 4)); fresh pixels start
// with dz = 0 at scale dcE.
export const perturbRowsDeep = (
  u0x: number,
  u0y: number,
  dcE: number,
  size: number,
  maxIter: number,
  orbit: Float64Array,
  rowStart: number,
  rowEnd: number,
  out: Float32Array,
  un?: UnresolvedBuf,
  bla: BlaTable | null = null,
  bad?: BadRefBuf,
  conf?: ConfirmBuf
): number => {
  let ranOut = 0;
  for (let py = rowStart; py < rowEnd; py++) {
    const uy = u0y + (py + 0.5);
    const rowIdx = py * size;
    for (let px = 0; px < size; px++) {
      const ux = u0x + (px + 0.5);
      let v = perturbPixelDeep(ux, uy, dcE, orbit, maxIter, 0, 0, 0, dcE, 0, bla);
      if (v === 0 && bla !== null && conf) {
        v = confirmInterior(
          conf, rowIdx + px, pixelState.n,
          (budget) => perturbPixelDeep(ux, uy, dcE, orbit, budget, 0, 0, 0, dcE, 0),
          maxIter
        );
      }
      if (v === BAD_REF) {
        if (bad) {
          if (bad.count === 0) {
            bad.dcx = ux;
            bad.dcy = uy;
            bad.e = dcE;
          }
          bad.count++;
        }
      } else if (v < 0) {
        ranOut++;
        if (un) recordUnresolved(un, rowIdx + px);
      }
      out[rowIdx + px] = v > 0 ? v : v === 0 ? INTERIOR : 0;
    }
  }
  return ranOut;
};
