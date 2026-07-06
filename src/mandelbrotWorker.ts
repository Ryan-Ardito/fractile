// Worker shim: message plumbing around the pure math in engine/mandelbrot.
// Long computations yield to the event loop between row bands so 'cancel'
// and 'set-reference' messages are processed mid-tile.

import {
  BAD_REF,
  BAILOUT,
  confirmInterior,
  directRows,
  escapeTime,
  makeUnresolvedBuf,
  perturbPixel,
  perturbPixelDeep,
  perturbRows,
  perturbRowsDeep,
  pixelState,
  referenceOrbit,
} from "./engine/mandelbrot";
import {
  BLA_MIN_LEVEL,
  DEEP_MIN_LEVEL,
  ITER_ESCALATION,
  ITER_HARD_CAP,
  RANOUT_PIXEL_THRESHOLD,
  TILE_APRON,
} from "./engine/camera";
import { BlaTable, buildBla } from "./engine/bla";
import {
  fixedToFloat,
  fixedToFloatExp,
  floatToFixed,
  floatToFixedShifted,
} from "./engine/fixedPoint";

type Reference = {
  orbit: Float64Array;
  cxFP: bigint;
  cyFP: bigint;
  bits: number;
  // BLA skip table, built on first deep use. Validity is per-pixel (each
  // entry bounds |dz| and |dc| separately), so one table serves every tile.
  bla: BlaTable | null;
};

type TileMsg = {
  type: "tile";
  id: number;
  key: string;
  level: number;
  tx: bigint;
  ty: bigint;
  size: number;
  maxIter: number;
  // Escalation ceiling for this job (idle refinement passes raise it past
  // the interactive hard cap); see the effective-cap guard in handleTile.
  iterCap?: number;
  refId: number | null;
  // Reference generation echoed back with results (see pool.ts Reference).
  refGen?: number;
  // The pool's reference-rescue budget is exhausted: render dc-starved
  // pixels black instead of signalling ref-unsuitable again.
  noRescue?: boolean;
};

type ReferenceMsg = {
  type: "reference";
  id: number;
  refId: number;
  cxFP: bigint;
  cyFP: bigint;
  bits: number;
  maxIter: number;
};

type SetReferenceMsg = {
  type: "set-reference";
  refId: number;
  orbit: Float64Array;
  cxFP: bigint;
  cyFP: bigint;
  bits: number;
};
type CancelMsg = { type: "cancel"; id: number };
type InMsg = TileMsg | ReferenceMsg | SetReferenceMsg | CancelMsg;

const post = postMessage as (msg: unknown, transfer?: Transferable[]) => void;

const references = new Map<number, Reference>();
const cancelled = new Set<number>();

// Macrotask yield via MessageChannel: pending main-thread messages (cancel,
// set-reference) are dispatched before the continuation runs.
const tickResolvers: Array<() => void> = [];
const tickChannel = new MessageChannel();
tickChannel.port1.onmessage = () => tickResolvers.shift()?.();
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    tickResolvers.push(resolve);
    tickChannel.port2.postMessage(0);
  });

const ROW_BAND = 16;
// Escalation passes yield for cancel/set-reference between chunks of pixels.
const ESCALATE_CHUNK = 2048;
// Tile-level canary (see below): sample size and the black-region size that
// warrants checking — blobs, not dust.
const CANARY_COUNT = 8;
const CANARY_MIN_BLACK = 2048;
// Wall-clock ceiling for a tile's adaptive escalation: where BLA compresses
// deep budgets, rungs are cheap and the ladder runs to the iteration cap;
// where it can't (shallow band, unsuitable reference), stop honestly rather
// than crawl — remaining unresolved pixels render black as before.
const ESCALATE_TIME_BUDGET_MS = 10000;
// Time-based progress flushing: any pass running longer than this posts a
// partial patch (rows so far / current state), so slow tiles paint at a
// steady few Hz instead of the screen looking hung until the pass ends.
const FLUSH_MS = 300;

const maxFiniteOf = (out: Float32Array): number => {
  let max = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
  return max;
};

const handleTile = async (msg: TileMsg): Promise<void> => {
  const { id, key, level, tx, ty, size, maxIter, refId } = msg;
  // Tiles are computed with a TILE_APRON-texel border of true neighbor data
  // on every side: the bicubic magnification kernel and the palette pass's
  // band-limit spread read past the logical edge, and without real data
  // there adjacent tiles visibly mismatch at their boundaries. `size` stays
  // the logical size; everything below runs on the physical grid.
  const phys = size + 2 * TILE_APRON;
  const t0 = performance.now();
  const out = new Float32Array(phys * phys);
  const un = makeUnresolvedBuf(phys * phys);
  const bad = { count: 0, dcx: 0, dcy: 0, e: 0 };
  const conf = { streak: 0 };
  const deep = level >= DEEP_MIN_LEVEL;

  // Bounded verdicts from dc-starved pixels mean the reference orbit escapes
  // while these pixels don't (a minibrot under an exterior reference): hand
  // the tile back so the pool can re-reference at one of them. With the
  // rescue budget exhausted, they render black — the pre-detection look.
  const reportBadRef = (): void => {
    if (un.count + bad.count < phys * phys) {
      post({
        type: "tile-progress",
        id,
        key,
        data: out.slice(),
        ranOut: un.count + bad.count,
        iterDone: maxIter,
        maxFinite: maxFiniteOf(out),
        costMs: performance.now() - t0,
        refGen: msg.refGen ?? 0,
      });
    }
    // Rescue center in absolute fixed-point (relative to the reference this
    // tile actually used — the pool's active reference may have moved on).
    post({
      type: "ref-unsuitable",
      id,
      key,
      cxFP:
        refObj!.cxFP +
        (bad.e === 0
          ? floatToFixed(bad.dcx, refObj!.bits)
          : floatToFixedShifted(bad.dcx, bad.e, refObj!.bits)),
      cyFP:
        refObj!.cyFP +
        (bad.e === 0
          ? floatToFixed(bad.dcy, refObj!.bits)
          : floatToFixedShifted(bad.dcy, bad.e, refObj!.bits)),
      bits: refObj!.bits,
    });
  };

  // Perturbation setup (deep tiles); null means the direct float64 path.
  let orbit: Float64Array | null = null;
  let bla: BlaTable | null = null;
  let refObj: Reference | null = null;
  let dcx0 = 0;
  let dcy0 = 0;
  // Deep path: dc in sample-pitch units (mantissa u, scale 2^dcE) — the
  // float64 tile width underflows past level ~1020.
  const dcE = -(level + 4);
  const tileW = 16 * 2 ** -level;
  const step = tileW / size;
  if (refId !== null) {
    const ref = references.get(refId);
    if (!ref) {
      post({ type: "no-ref", id, key });
      return;
    }
    refObj = ref;
    orbit = ref.orbit;
    const shift = BigInt(ref.bits + 4 - level);
    const eight = 8n << BigInt(ref.bits);
    if (deep) {
      const dx = fixedToFloatExp((tx << shift) - eight - ref.cxFP, ref.bits);
      const dy = fixedToFloatExp((ty << shift) - eight - ref.cyFP, ref.bits);
      // Exponent gaps stay small: tiles sit within the reference drift
      // tolerance, so the origin offset is at most ~2^15 sample pitches.
      // Guard the exact-zero offset (a tile origin flush with the reference,
      // common for rescaled shallow bookmarks): 0 · 2^huge is NaN.
      // Origin backed up by the apron (sample-pitch units on the deep path).
      dcx0 = (dx.m === 0 ? 0 : dx.m * 2 ** (dx.e - dcE)) - TILE_APRON;
      dcy0 = (dy.m === 0 ? 0 : dy.m * 2 ** (dy.e - dcE)) - TILE_APRON;
    } else {
      dcx0 =
        fixedToFloat((tx << shift) - eight - ref.cxFP, ref.bits) -
        TILE_APRON * step;
      dcy0 =
        fixedToFloat((ty << shift) - eight - ref.cyFP, ref.bits) -
        TILE_APRON * step;
    }
    if (level >= BLA_MIN_LEVEL) {
      if (!ref.bla) ref.bla = buildBla(ref.orbit);
      bla = ref.bla;
    }
  }
  const x0 = orbit ? dcx0 : Number(tx) * tileW - 8 - TILE_APRON * step;
  const y0 = orbit ? dcy0 : Number(ty) * tileW - 8 - TILE_APRON * step;
  // Per-pixel offset scale within the tile: 1 sample pitch on the deep path.
  const pixStep = orbit && deep ? 1 : step;

  // Effective iteration ceiling for this job. Idle refinement may raise it
  // past the interactive hard cap (toward ITER_ABS_CAP) — but only under an
  // ESCAPED reference orbit: truncated orbits are memory-capped at the base
  // cap (the pool never extends them further), and pixels budgeted beyond
  // the orbit would just park forever.
  let cap = msg.iterCap ?? ITER_HARD_CAP;
  if (orbit && cap > ITER_HARD_CAP) {
    const lastIdx = orbit.length - 2;
    const refEscaped =
      orbit[lastIdx] * orbit[lastIdx] + orbit[lastIdx + 1] * orbit[lastIdx + 1] >
      BAILOUT;
    if (!refEscaped) cap = ITER_HARD_CAP;
  }

  // First-pass budget: at least the reference orbit's own escape time — the
  // reference sits at the view center, so its escape count (plus margin)
  // predicts the neighborhood's needs far better than a per-level guess and
  // spares fresh deep views the escalation ladder entirely.
  let budget = Math.min(cap, maxIter);
  if (orbit) {
    budget = Math.min(
      cap,
      Math.max(budget, Math.ceil((orbit.length >> 1) * 1.25))
    );
  }

  // Partial-progress patch: rows [from, to) of the buffer so far. The
  // viewer applies these in place over a prefilled stand-in, so slow tiles
  // paint progressively instead of appearing all at once.
  let lastFlush = t0;
  let flushedRows = 0;
  const flushRows = (to: number): void => {
    post(
      {
        type: "tile-patch",
        id,
        key,
        phys,
        r0: flushedRows,
        r1: to,
        data: out.slice(flushedRows * phys, to * phys),
      }
    );
    flushedRows = to;
    lastFlush = performance.now();
  };

  // First pass, collecting unresolved pixel state.
  for (let row = 0; row < phys; row += ROW_BAND) {
    const rowEnd = Math.min(row + ROW_BAND, phys);
    if (orbit && deep) {
      perturbRowsDeep(
        dcx0, dcy0, dcE, phys, budget, orbit, row, rowEnd, out, un, bla,
        msg.noRescue ? undefined : bad, conf
      );
    } else if (orbit) {
      perturbRows(
        dcx0, dcy0, step, phys, budget, orbit, row, rowEnd, out, un, bla,
        msg.noRescue ? undefined : bad, conf
      );
    } else {
      directRows(x0, y0, step, phys, budget, row, rowEnd, out, un);
    }
    await tick();
    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({ type: "aborted", id, key });
      return;
    }
    if (rowEnd < phys && performance.now() - lastFlush >= FLUSH_MS) {
      flushRows(rowEnd);
    }
  }
  if (bad.count > 0) {
    reportBadRef();
    return;
  }

  // Adaptive escalation: resume only the unresolved pixels with ever-larger
  // budgets until the tile is clean (few enough ran-out pixels), progress
  // stalls, or the hard cap is reached. Escaped/interior pixels are never
  // recomputed. Each round posts a provisional frame so deep tiles appear
  // progressively instead of blocking until fully converged.
  let maxFinite = maxFiniteOf(out);
  while (
    un.count > RANOUT_PIXEL_THRESHOLD &&
    budget < cap &&
    performance.now() - t0 < ESCALATE_TIME_BUDGET_MS
  ) {
    // Show progress only once something resolved — an all-ran-out frame
    // would paint the tile as (wrong) solid interior.
    if (un.count < phys * phys) {
      post({
        type: "tile-progress",
        id,
        key,
        data: out.slice(),
        ranOut: un.count,
        iterDone: budget,
        maxFinite,
        costMs: performance.now() - t0,
        refGen: msg.refGen ?? 0,
      });
    }
    const next = Math.min(cap, budget * ITER_ESCALATION);
    let write = 0;
    for (let i = 0; i < un.count; i++) {
      const idx = un.idx[i];
      const px = idx % phys;
      const py = (idx / phys) | 0;
      const cx = x0 + (px + 0.5) * pixStep;
      const cy = y0 + (py + 0.5) * pixStep;
      let v = orbit
        ? deep
          ? perturbPixelDeep(cx, cy, dcE, orbit, next, un.n[i], un.ax[i], un.ay[i], un.s[i], un.m[i], bla, un.e2[i])
          : perturbPixel(cx, cy, orbit, next, un.n[i], un.ax[i], un.ay[i], un.m[i], bla, un.e2[i])
        : escapeTime(cx, cy, next, un.n[i], un.ax[i], un.ay[i], un.e2[i]);
      if (v === 0 && orbit && bla !== null) {
        v = confirmInterior(
          conf, idx, pixelState.n,
          (b) => deep
            ? perturbPixelDeep(cx, cy, dcE, orbit!, b, 0, 0, 0, dcE, 0)
            : perturbPixel(cx, cy, orbit!, b),
          next
        );
      }
      if (v === BAD_REF && !msg.noRescue) {
        if (bad.count === 0) {
          bad.dcx = cx;
          bad.dcy = cy;
          bad.e = deep ? dcE : 0;
        }
        bad.count++;
        out[idx] = 0;
      } else if (v < 0 && v !== BAD_REF) {
        un.idx[write] = idx;
        un.ax[write] = pixelState.ax;
        un.ay[write] = pixelState.ay;
        un.s[write] = pixelState.s;
        un.m[write] = pixelState.m;
        un.n[write] = pixelState.n;
        un.e2[write] = pixelState.e2;
        write++;
      } else {
        out[idx] = v > 0 ? v : 0;
        if (v > maxFinite) maxFinite = v;
      }
      if ((i & (ESCALATE_CHUNK - 1)) === ESCALATE_CHUNK - 1) {
        await tick();
        if (cancelled.has(id)) {
          cancelled.delete(id);
          post({ type: "aborted", id, key });
          return;
        }
        // Escalation touches scattered pixels; flush the whole buffer.
        if (performance.now() - lastFlush >= FLUSH_MS) {
          flushedRows = 0;
          flushRows(phys);
        }
      }
    }
    un.count = write;
    budget = next;
    if (bad.count > 0) {
      reportBadRef();
      return;
    }
    // No early exit on a fruitless round: an escape band can start above
    // several ladder rungs at once (fresh deep views), and true interiors
    // resolve via cycle detection long before the hard cap anyway.
  }

  // Tile-level canary against BLA trajectory corruption: the per-fire
  // confirmation only covers interior verdicts below its ceiling, and
  // corrupted trajectories can also surface as ran-out black. If this
  // BLA-assisted tile ends with a substantial black region, replay a few
  // deterministically-spread black pixels PLAIN; any flip to escape proves
  // the black untrustworthy, and every black pixel is recomputed plain —
  // the honest price, paid only on proven corruption. True-interior tiles
  // pay ~8 replays and move on.
  if (orbit && bla !== null && !cancelled.has(id)) {
    const black: number[] = [];
    for (let i = 0; i < out.length; i++) if (out[i] === 0) black.push(i);
    if (black.length >= CANARY_MIN_BLACK) {
      const plainPixel = (idx: number, budgetP: number): number => {
        const px = idx % phys;
        const py = (idx / phys) | 0;
        const cx = x0 + (px + 0.5) * pixStep;
        const cy = y0 + (py + 0.5) * pixStep;
        return deep
          ? perturbPixelDeep(cx, cy, dcE, orbit!, budgetP, 0, 0, 0, dcE, 0)
          : perturbPixel(cx, cy, orbit!, budgetP);
      };
      let flipped = false;
      const stride = Math.max(1, Math.floor(black.length / CANARY_COUNT));
      for (let k = 0; k < CANARY_COUNT && k * stride < black.length; k++) {
        if (plainPixel(black[k * stride], budget) > 0) {
          flipped = true;
          break;
        }
      }
      if (flipped) {
        for (let i = 0; i < black.length; i++) {
          const v = plainPixel(black[i], budget);
          if (v > 0) {
            out[black[i]] = v;
            if (v > maxFinite) maxFinite = v;
          }
          if ((i & (ESCALATE_CHUNK - 1)) === ESCALATE_CHUNK - 1) {
            await tick();
            if (cancelled.has(id)) {
              cancelled.delete(id);
              post({ type: "aborted", id, key });
              return;
            }
            if (performance.now() - lastFlush >= FLUSH_MS) {
              flushedRows = 0;
              flushRows(phys);
            }
          }
        }
      }
    }
  }

  // Unresolved pixels against a budget-truncated (never-escaped) reference
  // are blocked on orbit length, not iteration count: show what resolved,
  // then hand the tile back so the pool can extend the reference.
  if (orbit && un.count > RANOUT_PIXEL_THRESHOLD) {
    const lastIdx = orbit.length - 2;
    const escaped =
      orbit[lastIdx] * orbit[lastIdx] + orbit[lastIdx + 1] * orbit[lastIdx + 1] >
      BAILOUT;
    if (!escaped && (orbit.length >> 1) <= budget) {
      post({
        type: "tile-progress",
        id,
        key,
        data: out,
        ranOut: un.count,
        iterDone: budget,
        maxFinite,
        costMs: performance.now() - t0,
        refGen: msg.refGen ?? 0,
      });
      post({ type: "ref-short", id, key });
      return;
    }
  }

  post(
    {
      type: "tile",
      id,
      key,
      data: out,
      ranOut: un.count,
      iterDone: budget,
      maxFinite,
      costMs: performance.now() - t0,
      refGen: msg.refGen ?? 0,
    },
    [out.buffer]
  );
};

// Resume state of the last budget-truncated reference this worker computed:
// same-center extensions (the pool's ref-short ×4 ladder) continue the
// BigInt iteration instead of recomputing the whole prefix. Kept as a copy
// (the posted orbit's buffer is transferred away); dropped once the orbit
// escapes — escaped orbits are complete and never extended.
let refResume:
  | {
      cxFP: bigint;
      cyFP: bigint;
      bits: number;
      zx: bigint;
      zy: bigint;
      n: number;
      orbit: Float64Array;
    }
  | null = null;

const handleReference = async (msg: ReferenceMsg): Promise<void> => {
  const { id, refId, cxFP, cyFP, bits, maxIter } = msg;
  const resume =
    refResume &&
    refResume.cxFP === cxFP &&
    refResume.cyFP === cyFP &&
    refResume.bits === bits &&
    refResume.n <= maxIter
      ? refResume
      : undefined;
  const gen = referenceOrbit(cxFP, cyFP, bits, maxIter, 1024, resume);
  for (;;) {
    const step = gen.next();
    if (step.done) {
      const res = step.value;
      refResume = res.escaped
        ? null
        : {
            cxFP,
            cyFP,
            bits,
            zx: res.zx,
            zy: res.zy,
            n: res.n,
            orbit: res.orbit.slice(),
          };
      post({ type: "reference", id, refId, orbit: res.orbit, cxFP, cyFP, bits }, [
        res.orbit.buffer,
      ]);
      return;
    }
    await tick();
    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({ type: "aborted", id, key: "" });
      return;
    }
  }
};

onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case "tile":
      void handleTile(msg);
      break;
    case "reference":
      void handleReference(msg);
      break;
    case "set-reference": {
      // A same-center replacement (an extension or re-length) strictly
      // supersedes its predecessor — drop it immediately rather than hold
      // two multi-megabyte orbits; in-flight tiles against the old refId
      // bounce off "no-ref" and requeue.
      for (const [staleId, ref] of references) {
        if (ref.cxFP === msg.cxFP && ref.cyFP === msg.cyFP && ref.bits === msg.bits) {
          references.delete(staleId);
        }
      }
      references.set(msg.refId, {
        orbit: msg.orbit,
        cxFP: msg.cxFP,
        cyFP: msg.cyFP,
        bits: msg.bits,
        bla: null,
      });
      // Keep at most two references: the active one plus its predecessor for
      // tiles already in flight.
      for (const staleId of references.keys()) {
        if (references.size <= 2) break;
        references.delete(staleId);
      }
      break;
    }
    case "cancel":
      cancelled.add(msg.id);
      break;
  }
};
