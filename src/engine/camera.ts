// Deep-zoom camera. The view center lives in BigInt fixed-point (precision
// grows with zoom); zoom itself is a continuous float. The coordinate frame
// never moves — tile identity (level, tx, ty) is exact integers forever, so
// caches and fades survive any depth. Only screen-relative differences are
// ever lowered to float64.
//
// Complex-plane convention matches the old worker: tile (level, tx, ty)
// covers [tx·w − 8, (tx+1)·w − 8] × [ty·w − 8, (ty+1)·w − 8] with
// w = 16·2^−level, and the imaginary axis points *down* the screen.

import { fixedToFloat, floatToFixed, rescale } from "./fixedPoint";

export const MIN_ZOOM = 3;
// Plain float64 perturbation deltas stay healthy to ~1e-290; cap with margin.
export const MAX_ZOOM = 940;
export const TILE_SIZE = 256;
export const BASE_ITERATIONS = 1024;
// Below this level, float64 addresses pixels directly; above it, perturbation.
export const PERTURB_MIN_LEVEL = 36;

// Adaptive iterations (shared by the worker and the viewer): a tile whose
// ran-out pixel count exceeds the threshold keeps iterating — the worker
// resumes just the unresolved pixels at ESCALATION x the budget until clean,
// stalled, or capped. This finds "the iteration count above which you see no
// visual improvement" in a single job, with no tile recomputes.
export const RANOUT_PIXEL_THRESHOLD = 32;
export const ITER_ESCALATION = 4;
export const ITER_HARD_CAP = 1 << 20;

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

  // Complex units per CSS pixel.
  pixelSize(): number {
    return 2 ** (-this.zoom - 4);
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
    const ps = this.pixelSize();
    this.cxFP += floatToFixed(dx * ps, this.bits);
    this.cyFP += floatToFixed(dy * ps, this.bits);
    this.clampCenter();
  }

  // Zoom keeping the complex point at CSS offset (ax, ay) from the canvas
  // center fixed on screen.
  zoomTo(zoom: number, ax = 0, ay = 0): void {
    const psOld = this.pixelSize();
    this.zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    this.ensurePrecision();
    const psNew = this.pixelSize();
    this.cxFP += floatToFixed(ax * (psOld - psNew), this.bits);
    this.cyFP += floatToFixed(ay * (psOld - psNew), this.bits);
    this.clampCenter();
  }

  // Complex coordinates (fixed-point, this.bits) at a CSS offset from center.
  complexAt(ax: number, ay: number): [bigint, bigint] {
    const ps = this.pixelSize();
    return [
      this.cxFP + floatToFixed(ax * ps, this.bits),
      this.cyFP + floatToFixed(ay * ps, this.bits),
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
    const tileW = 16 * 2 ** -level;
    const shift = BigInt(this.bits + 4 - level);
    const eight = 8n << BigInt(this.bits);

    const nx = this.cxFP + eight;
    const ny = this.cyFP + eight;
    const txc = nx >> shift; // floor — BigInt >> rounds toward -inf
    const tyc = ny >> shift;
    const fracX = fixedToFloat(nx - (txc << shift), this.bits) / tileW;
    const fracY = fixedToFloat(ny - (tyc << shift), this.bits) / tileW;

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
