// Micro-benchmarks for the CPU-side hot paths. Run: `npm run bench`.
//
// Covers what runs off the GPU:
//  - compute: the float64 escape-time loop (directRows) and the perturbation
//    loop (perturbRows + BLA), the per-pixel math.
//  - frame glue: visibleTiles + tileKey generation, the per-frame key churn
//    the render loop pays for every visible tile, several times over.
//
// It is a regression guard and an A/B tool, not a precise profiler: numbers
// are wall-clock over fixed work, best-of-N to shed scheduler noise.

import { buildBla } from "../src/engine/bla";
import {
  directRows,
  perturbRows,
  referenceOrbit,
} from "../src/engine/mandelbrot";
import { DeepCamera } from "../src/engine/camera";
import { floatToFixed, fixedToFloat } from "../src/engine/fixedPoint";

const bestMs = (runs: number, fn: () => void): number => {
  // One warmup so V8 has tiered up before we measure.
  fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    const dt = performance.now() - t;
    if (dt < best) best = dt;
  }
  return best;
};

const fmt = (n: number, u = "ms") => `${n.toFixed(3)} ${u}`;

// --- compute: direct float64 path (shallow view) ---
const directBench = () => {
  const size = 260; // 256 logical + 2*2 apron
  const out = new Float32Array(size * size);
  const step = (16 * 2 ** -4) / 256;
  const x0 = -0.5 - 130 * step;
  const y0 = 0.0 - 130 * step;
  const maxIter = 1024;
  const ms = bestMs(5, () =>
    directRows(x0, y0, step, size, maxIter, 0, size, out)
  );
  const px = size * size;
  console.log(
    `direct   (${size}² px, ${maxIter} iters): ${fmt(ms)}  ` +
      `${fmt((px / ms) * 1e-3, "Mpx/s")}`
  );
};

// --- compute: perturbation path + BLA (deep view) ---
const perturbBench = () => {
  const level = 60;
  const bits = 64 * Math.ceil((level + 80) / 64);
  // A center just off the real axis inside a filament-rich region.
  const cx = -0.743643887037151;
  const cy = 0.13182590420533;
  const cxFP = floatToFixed(cx, bits);
  const cyFP = floatToFixed(cy, bits);
  const maxIter = 4096;
  // Reference orbit (BigInt) at the view center.
  let orbit = new Float64Array(0);
  const gen = referenceOrbit(cxFP, cyFP, bits, maxIter, 1 << 30);
  for (;;) {
    const s = gen.next();
    if (s.done) {
      orbit = s.value.orbit;
      break;
    }
  }
  const bla = buildBla(orbit);
  const size = 260;
  const out = new Float32Array(size * size);
  const tileW = 16 * 2 ** -level;
  const step = tileW / 256;
  // dc offset of the tile origin: reference is at the tile center.
  const dc0 = -(size / 2) * step;
  const ms = bestMs(5, () =>
    perturbRows(dc0, dc0, step, size, maxIter, orbit, 0, size, out, undefined, bla)
  );
  const px = size * size;
  console.log(
    `perturb  (${size}² px, ${maxIter} iters, lvl ${level}, orbit ${
      orbit.length >> 1
    }): ${fmt(ms)}  ${fmt((px / ms) * 1e-3, "Mpx/s")}`
  );
};

// --- frame glue: visibleTiles + tileKey churn ---
// Mirrors what the render loop does: for every visible tile it builds several
// string keys (self, 4 children for synthesis, ancestors for fallback). We
// model ~6 keys/tile to approximate that churn.
const tileKey = (level: number, tx: bigint, ty: bigint): string =>
  `${level}:${tx}:${ty}`;

const frameGlueBench = (zoom: number, label: string) => {
  const cam = new DeepCamera(zoom, -0.743643887037151, 0.13182590420533);
  // Force the deep-zoom BigInt magnitudes the real cache keys carry.
  void fixedToFloat(cam.cxFP, cam.bits);
  const FRAMES = 2000;
  let sink = 0;
  const ms = bestMs(5, () => {
    for (let f = 0; f < FRAMES; f++) {
      const vis = cam.visibleTiles(1920, 1080, 1);
      for (const t of vis.tiles) {
        // ~6 keys per tile: self + 4 children + 1 parent.
        sink += tileKey(vis.level, t.tx, t.ty).length;
        sink += tileKey(vis.level + 1, t.tx * 2n, t.ty * 2n).length;
        sink += tileKey(vis.level + 1, t.tx * 2n + 1n, t.ty * 2n).length;
        sink += tileKey(vis.level + 1, t.tx * 2n, t.ty * 2n + 1n).length;
        sink += tileKey(vis.level + 1, t.tx * 2n + 1n, t.ty * 2n + 1n).length;
        sink += tileKey(vis.level - 1, t.tx >> 1n, t.ty >> 1n).length;
      }
    }
  });
  const tiles = cam.visibleTiles(1920, 1080, 1).tiles.length;
  if (sink === -1) console.log("unreachable");
  console.log(
    `frame    (${label}, ${tiles} tiles, ${FRAMES} frames): ${fmt(ms)}  ` +
      `${fmt(ms / FRAMES, "ms/frame")}`
  );
};

console.log("fractile CPU benchmarks (best of 5)\n");
directBench();
perturbBench();
frameGlueBench(8, "shallow z8");
frameGlueBench(120, "deep z120");
