// Deep-zoom camera. The view center lives in BigInt fixed-point (precision
// grows with zoom); zoom itself is a continuous float. The coordinate frame
// never moves — tile identity (level, tx, ty) is exact integers forever, so
// caches and fades survive any depth. Only screen-relative differences are
// ever lowered to float64.
//
// Complex-plane convention matches the old worker: tile (level, tx, ty)
// covers [tx·w − 8, (tx+1)·w − 8] × [ty·w − 8, (ty+1)·w − 8] with
// w = 16·2^−level, and the imaginary axis points *down* the screen.

import {
  fixedToFloat,
  fixedToFloatScaled,
  floatToFixed,
  floatToFixedShifted,
  rescale,
} from "./fixedPoint";

export const MIN_ZOOM = 3;
// With the extended-exponent (floatexp) deep pixel path there is no float64
// delta ceiling; the practical limit is BigInt reference-orbit cost, which
// grows with precision. 100k zoom levels ≈ 10^30103.
export const MAX_ZOOM = 100_000;
export const TILE_SIZE = 256;
// Tiles are computed with this many texels of true border data on each side
// (physical = size + 2·TILE_APRON). The bicubic magnification kernel and the
// palette pass's band-limit spread both read up to 2 texels past a logical
// edge; without real data there, every tile boundary bends its interpolation
// against a clamped edge texel and adjacent magnified tiles visibly mismatch.
export const TILE_APRON = 2;
export const BASE_ITERATIONS = 1024;
// Below this level, float64 addresses pixels directly; above it, perturbation.
export const PERTURB_MIN_LEVEL = 36;
// Use BLA only from this level down. Its validity radii are tuned for
// escape-time accuracy (chaos-class); in the band where pixel deltas are
// large enough to sit within ~2^16 of the radii (levels ~36-96),
// near-parabolic error accumulation can corrupt BOUNDED verdicts (false
// "interior" — black blobs swallowing minibrots), and BLA's measured
// speedup there is ~1x anyway. Deeper, deltas are astronomically far inside
// the radii: safe and where the speedup actually lives.
export const BLA_MIN_LEVEL = 96;
// From this level down, tiles use the extended-exponent (floatexp) pixel
// path: dz/dc carry an explicit power-of-two exponent so they survive past
// float64's ~1e-308 floor (zoom ~940 was the old ceiling; switch early with
// margin). Below it, the plain float64 path runs untouched.
export const DEEP_MIN_LEVEL = 900;

// Adaptive iterations (shared by the worker and the viewer): a tile whose
// ran-out pixel count exceeds the threshold keeps iterating — the worker
// resumes just the unresolved pixels at ESCALATION x the budget until clean,
// stalled, or capped. This finds "the iteration count above which you see no
// visual improvement" in a single job, with no tile recomputes.
export const RANOUT_PIXEL_THRESHOLD = 32;
export const ITER_ESCALATION = 4;
// Measured at real minibrot fringes (z162): visible halo pixels escape at
// 1-2.4M — just past the old 2^20 cap — and cost ~0.2ms each with BLA and a
// suitable (near-cycle) reference, so the cap buys visible detail almost
// free at depth. It is memory-coupled: parked pixels need the reference
// orbit as long as their budget (16 bytes/iteration/worker), so 2^22 keeps
// the worst-case orbit at ~67MB. The escalation ladder's wall-clock guard
// (worker) bounds the BLA-weak worst case in time, not iterations.
export const ITER_HARD_CAP = 1 << 22;

const CLAMP_X = 12;
const CLAMP_Y = 6;

export const requiredBits = (zoom: number): number =>
  64 * Math.ceil((zoom + 80) / 64);

export type VisibleTile = {
  tx: bigint;
  ty: bigint;
  // CSS-pixel position of the tile's top-left corner on the canvas.
  x: number;
  y: number;
};

export type VisibleSet = {
  level: number;
  tilePx: number; // on-screen CSS size of one tile
  tiles: VisibleTile[];
};

export class DeepCamera {
  zoom: number;
  bits: number;
  cxFP: bigint;
  cyFP: bigint;

  constructor(zoom = 4, cx = -0.48, cy = 0) {
    this.zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    this.bits = requiredBits(this.zoom);
    this.cxFP = floatToFixed(cx, this.bits);
    this.cyFP = floatToFixed(cy, this.bits);
  }

  // Complex units per CSS pixel, as mantissa·2^exponent — float64 alone
  // underflows past zoom ~1015. m is in (0.5, 1].
  pixelSizeParts(): { m: number; e: number } {
    const zi = Math.floor(this.zoom);
    return { m: 2 ** -(this.zoom - zi), e: -zi - 4 };
  }


  private ensurePrecision(): void {
    const nb = requiredBits(this.zoom);
    if (nb !== this.bits) {
      this.cxFP = rescale(this.cxFP, this.bits, nb);
      this.cyFP = rescale(this.cyFP, this.bits, nb);
      this.bits = nb;
    }
  }

  private clampCenter(): void {
    const cx = fixedToFloat(this.cxFP, this.bits);
    const cy = fixedToFloat(this.cyFP, this.bits);
    if (cx > CLAMP_X) this.cxFP = floatToFixed(CLAMP_X, this.bits);
    if (cx < -CLAMP_X) this.cxFP = floatToFixed(-CLAMP_X, this.bits);
    if (cy > CLAMP_Y) this.cyFP = floatToFixed(CLAMP_Y, this.bits);
    if (cy < -CLAMP_Y) this.cyFP = floatToFixed(-CLAMP_Y, this.bits);
  }

  panPixels(dx: number, dy: number): void {
    const ps = this.pixelSizeParts();
    this.cxFP += floatToFixedShifted(dx * ps.m, ps.e, this.bits);
    this.cyFP += floatToFixedShifted(dy * ps.m, ps.e, this.bits);
    this.clampCenter();
  }

  // Zoom keeping the complex point at CSS offset (ax, ay) from the canvas
  // center fixed on screen.
  zoomTo(zoom: number, ax = 0, ay = 0): void {
    const psOld = this.pixelSizeParts();
    this.zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    this.ensurePrecision();
    const psNew = this.pixelSizeParts();
    // ax·(psOld − psNew) as two exponent-scaled contributions.
    this.cxFP +=
      floatToFixedShifted(ax * psOld.m, psOld.e, this.bits) -
      floatToFixedShifted(ax * psNew.m, psNew.e, this.bits);
    this.cyFP +=
      floatToFixedShifted(ay * psOld.m, psOld.e, this.bits) -
      floatToFixedShifted(ay * psNew.m, psNew.e, this.bits);
    this.clampCenter();
  }

  // Complex coordinates (fixed-point, this.bits) at a CSS offset from center.
  complexAt(ax: number, ay: number): [bigint, bigint] {
    const ps = this.pixelSizeParts();
    return [
      this.cxFP + floatToFixedShifted(ax * ps.m, ps.e, this.bits),
      this.cyFP + floatToFixedShifted(ay * ps.m, ps.e, this.bits),
    ];
  }

  setCenterFP(cxFP: bigint, cyFP: bigint, bits: number): void {
    this.cxFP = rescale(cxFP, bits, this.bits);
    this.cyFP = rescale(cyFP, bits, this.bits);
    this.clampCenter();
  }

  setZoom(zoom: number): void {
    this.zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    this.ensurePrecision();
  }

  visibleTiles(wCss: number, hCss: number, dpr: number): VisibleSet {
    const level = Math.min(
      Math.max(Math.round(this.zoom + Math.log2(dpr)), 0),
      Math.ceil(MAX_ZOOM) + 2
    );
    const tilePx = TILE_SIZE * 2 ** (this.zoom - level);
    const shift = BigInt(this.bits + 4 - level);
    const eight = 8n << BigInt(this.bits);

    const nx = this.cxFP + eight;
    const ny = this.cyFP + eight;
    const txc = nx >> shift; // floor — BigInt >> rounds toward -inf
    const tyc = ny >> shift;
    // Remainder / tile width, computed in exponent space (the tile width
    // 2^(4-level) underflows float64 at depth).
    const fracX = fixedToFloatScaled(nx - (txc << shift), this.bits, 4 - level);
    const fracY = fixedToFloatScaled(ny - (tyc << shift), this.bits, 4 - level);

    // Screen position of the center tile's origin.
    const ox = wCss / 2 - fracX * tilePx;
    const oy = hCss / 2 - fracY * tilePx;

    const worldTiles = 1n << BigInt(level);
    const tiles: VisibleTile[] = [];
    const iMin = Math.floor(-ox / tilePx);
    const iMax = Math.floor((wCss - ox) / tilePx);
    const jMin = Math.floor(-oy / tilePx);
    const jMax = Math.floor((hCss - oy) / tilePx);
    for (let j = jMin; j <= jMax; j++) {
      const ty = tyc + BigInt(j);
      if (ty < 0n || ty >= worldTiles) continue;
      for (let i = iMin; i <= iMax; i++) {
        const tx = txc + BigInt(i);
        if (tx < 0n || tx >= worldTiles) continue;
        tiles.push({ tx, ty, x: ox + i * tilePx, y: oy + j * tilePx });
      }
    }
    return { level, tilePx, tiles };
  }
}
