// Bivariate linear approximation (BLA) tables for perturbation iteration.
//
// Wherever a pixel's delta is small relative to the reference orbit value,
// one iteration dz' = (2Z + dz)·dz + dc is linear in (dz, dc) to within
// double precision: dz' ≈ A·dz + B·dc with A = 2Z, B = 1. Consecutive linear
// steps compose (A = A2·A1, B = A2·B1 + B2), so precomposed blocks covering
// 2^k·LMIN iterations let the per-pixel loop skip long stretches at once —
// order-of-magnitude speedups at depth, where escape times are huge but
// orbits spend most of their time closely shadowing the reference.
//
// Validity is two separate runtime bounds per entry: |dz| < rz and
// |dc| < rc. Keeping the dc bound out of the table (rather than baking a
// worst-case |dc| into a single radius) matters enormously: deep pixels have
// astronomically small dc, so entries whose derivative growth would choke on
// a worst-case bound remain usable exactly where the speedup lives. Within
// the bounds, every sub-step provably stayed in its own linear range — which
// also implies the pixel could not have escaped or needed a rebase
// mid-block, so skips compose safely with Zhuoran rebasing.
//
// Overflow/underflow is safe by construction: entries whose coefficients
// overflow end up with zero/NaN radii and are simply never applied, and
// validity compares magnitudes, not squared magnitudes, so radii keep
// working at depths where |dz|² would underflow to zero.

export const BLA_LMIN = 16; // iterations covered by a level-0 entry
export const BLA_LMIN_LOG2 = 4;
// Per-step relative linearization tolerance. In chaotic zones any rounding
// difference (BLA or not) is amplified anyway — verified against BigInt
// ground truth that BLA sits as close to truth as plain float64 iteration.
const EPS = 2 ** -24;
// When a sub-step's radius must cover both the dz and dc inputs, give dz the
// lion's share: deep pixels (the whole point of BLA) have astronomically
// small dc, and an even split would compound a 2^k radius penalty onto
// level-k entries; (15/16)^k is benign.
const ZSPLIT = 15 / 16;

export type BlaLevel = {
  len: number; // iterations skipped by one entry at this level
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  rz: Float64Array;
  rc: Float64Array;
  // Max SQUARED partial |prod 2Z| along the block (s = 1..len). The interior
  // test's running-max defense needs the within-period e2 peaks; a skip only
  // exposes e2 at block ends, and near-parabolic cycles can phase-lock those
  // sample points into low-e2 phases — false interior verdicts (verified at
  // a period-5652 component edge: plain e2 never dropped below 1e4 while the
  // BLA-sampled maxima fired the verdict). Skips contribute e2·pk to the max.
  pk: Float64Array;
};

export type BlaTable = { levels: BlaLevel[] };

const mag = (x: number, y: number): number => Math.sqrt(x * x + y * y);

export const buildBla = (orbit: Float64Array, eps = EPS): BlaTable => {
  // Single steps exist for orbit indices [0, last-1]; a level-0 block of
  // LMIN steps starting at j·LMIN must end at an index that still exists.
  const last = (orbit.length >> 1) - 1;
  const blocks = Math.floor(last / BLA_LMIN);
  const levels: BlaLevel[] = [];
  if (blocks < 1) return { levels };

  const ax = new Float64Array(blocks);
  const ay = new Float64Array(blocks);
  const bx = new Float64Array(blocks);
  const by = new Float64Array(blocks);
  const rz = new Float64Array(blocks);
  const rc = new Float64Array(blocks);
  const pk = new Float64Array(blocks);
  for (let j = 0; j < blocks; j++) {
    const m0 = j * BLA_LMIN;
    // Sub-step 0 constraint: |dz| ≤ ε|Z| with the identity map (no dc term
    // yet). Index 0 has Z = 0, so block 0 is permanently invalid — pixels
    // freshly rebased to the orbit start take plain steps, as they must.
    let accAx = 2 * orbit[2 * m0];
    let accAy = 2 * orbit[2 * m0 + 1];
    let accBx = 1;
    let accBy = 0;
    let accRz = eps * mag(orbit[2 * m0], orbit[2 * m0 + 1]);
    let accRc = Infinity;
    let accPk = accAx * accAx + accAy * accAy;
    for (let s = 1; s < BLA_LMIN; s++) {
      const m = m0 + s;
      const zx = orbit[2 * m];
      const zy = orbit[2 * m + 1];
      // Sub-step s sees acc(dz, dc); split its radius budget between them.
      const lim = eps * mag(zx, zy);
      accRz = Math.min(accRz, (ZSPLIT * lim) / mag(accAx, accAy));
      accRc = Math.min(accRc, ((1 - ZSPLIT) * lim) / mag(accBx, accBy));
      // acc = single ∘ acc:  A = 2Z·A,  B = 2Z·B + 1
      const sAx = 2 * zx;
      const sAy = 2 * zy;
      const nAx = sAx * accAx - sAy * accAy;
      accAy = sAx * accAy + sAy * accAx;
      accAx = nAx;
      const nBx = sAx * accBx - sAy * accBy + 1;
      accBy = sAx * accBy + sAy * accBx;
      accBx = nBx;
      const a2 = accAx * accAx + accAy * accAy;
      if (a2 > accPk) accPk = a2;
    }
    ax[j] = accAx;
    ay[j] = accAy;
    bx[j] = accBx;
    by[j] = accBy;
    rz[j] = accRz;
    rc[j] = accRc;
    pk[j] = accPk;
  }
  levels.push({ len: BLA_LMIN, ax, ay, bx, by, rz, rc, pk });

  // Merge pairs upward until a single entry spans (nearly) the whole orbit.
  // The follower y must see |A_x·dz + B_x·dc| ≤ rz_y; same lopsided split.
  for (let prev = levels[0]; prev.rz.length >= 2; ) {
    const n2 = prev.rz.length >> 1;
    const lvl: BlaLevel = {
      len: prev.len * 2,
      ax: new Float64Array(n2),
      ay: new Float64Array(n2),
      bx: new Float64Array(n2),
      by: new Float64Array(n2),
      rz: new Float64Array(n2),
      rc: new Float64Array(n2),
      pk: new Float64Array(n2),
    };
    for (let j = 0; j < n2; j++) {
      const a = 2 * j;
      const b = 2 * j + 1;
      lvl.rz[j] = Math.min(
        prev.rz[a],
        (ZSPLIT * prev.rz[b]) / mag(prev.ax[a], prev.ay[a])
      );
      lvl.rc[j] = Math.min(
        prev.rc[a],
        prev.rc[b],
        ((1 - ZSPLIT) * prev.rz[b]) / mag(prev.bx[a], prev.by[a])
      );
      // Peak partial across the pair: first half's peak, or the first
      // half's full |A|² carrying into the second half's peak.
      const aMag2 = prev.ax[a] * prev.ax[a] + prev.ay[a] * prev.ay[a];
      lvl.pk[j] = Math.max(prev.pk[a], aMag2 * prev.pk[b]);
      lvl.ax[j] = prev.ax[b] * prev.ax[a] - prev.ay[b] * prev.ay[a];
      lvl.ay[j] = prev.ax[b] * prev.ay[a] + prev.ay[b] * prev.ax[a];
      lvl.bx[j] = prev.ax[b] * prev.bx[a] - prev.ay[b] * prev.by[a] + prev.bx[b];
      lvl.by[j] = prev.ax[b] * prev.by[a] + prev.ay[b] * prev.bx[a] + prev.by[b];
    }
    levels.push(lvl);
    prev = lvl;
  }
  return { levels };
};
