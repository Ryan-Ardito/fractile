// Worker shim: message plumbing around the pure math in engine/mandelbrot.
// Long computations yield to the event loop between row bands so 'cancel'
// and 'set-reference' messages are processed mid-tile.

import {
  BAD_REF,
  BAILOUT,
  directRows,
  escapeTime,
  makeUnresolvedBuf,
  perturbPixel,
  perturbRows,
  pixelState,
  referenceOrbit,
} from "./engine/mandelbrot";
import {
  BLA_MIN_LEVEL,
  ITER_ESCALATION,
  ITER_HARD_CAP,
  RANOUT_PIXEL_THRESHOLD,
} from "./engine/camera";
import { BlaTable, buildBla } from "./engine/bla";
import { fixedToFloat, floatToFixed } from "./engine/fixedPoint";

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
  refId: number | null;
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

const maxFiniteOf = (out: Float32Array): number => {
  let max = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
  return max;
};

const handleTile = async (msg: TileMsg): Promise<void> => {
  const { id, key, level, tx, ty, size, maxIter, refId } = msg;
  const t0 = performance.now();
  const out = new Float32Array(size * size);
  const un = makeUnresolvedBuf(size * size);
  const bad = { count: 0, dcx: 0, dcy: 0 };

  // Bounded verdicts from dc-starved pixels mean the reference orbit escapes
  // while these pixels don't (a minibrot under an exterior reference): hand
  // the tile back so the pool can re-reference at one of them. With the
  // rescue budget exhausted, they render black — the pre-detection look.
  const reportBadRef = (): void => {
    if (un.count + bad.count < size * size) {
      post({
        type: "tile-progress",
        id,
        key,
        data: out.slice(),
        ranOut: un.count + bad.count,
        iterDone: maxIter,
        maxFinite: maxFiniteOf(out),
        costMs: performance.now() - t0,
      });
    }
    // Rescue center in absolute fixed-point (relative to the reference this
    // tile actually used — the pool's active reference may have moved on).
    post({
      type: "ref-unsuitable",
      id,
      key,
      cxFP: refObj!.cxFP + floatToFixed(bad.dcx, refObj!.bits),
      cyFP: refObj!.cyFP + floatToFixed(bad.dcy, refObj!.bits),
      bits: refObj!.bits,
    });
  };

  // Perturbation setup (deep tiles); null means the direct float64 path.
  let orbit: Float64Array | null = null;
  let bla: BlaTable | null = null;
  let refObj: Reference | null = null;
  let dcx0 = 0;
  let dcy0 = 0;
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
    dcx0 = fixedToFloat((tx << shift) - eight - ref.cxFP, ref.bits);
    dcy0 = fixedToFloat((ty << shift) - eight - ref.cyFP, ref.bits);
    if (level >= BLA_MIN_LEVEL) {
      if (!ref.bla) ref.bla = buildBla(ref.orbit);
      bla = ref.bla;
    }
  }
  const x0 = orbit ? dcx0 : Number(tx) * tileW - 8;
  const y0 = orbit ? dcy0 : Number(ty) * tileW - 8;

  // First-pass budget: at least the reference orbit's own escape time — the
  // reference sits at the view center, so its escape count (plus margin)
  // predicts the neighborhood's needs far better than a per-level guess and
  // spares fresh deep views the escalation ladder entirely.
  let budget = maxIter;
  if (orbit) {
    budget = Math.min(
      ITER_HARD_CAP,
      Math.max(budget, Math.ceil((orbit.length >> 1) * 1.25))
    );
  }

  // First pass, collecting unresolved pixel state.
  for (let row = 0; row < size; row += ROW_BAND) {
    const rowEnd = Math.min(row + ROW_BAND, size);
    if (orbit) {
      perturbRows(
        dcx0, dcy0, step, size, budget, orbit, row, rowEnd, out, un, bla,
        msg.noRescue ? undefined : bad
      );
    } else {
      directRows(level, Number(tx), Number(ty), size, budget, row, rowEnd, out, un);
    }
    await tick();
    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({ type: "aborted", id, key });
      return;
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
  while (un.count > RANOUT_PIXEL_THRESHOLD && budget < ITER_HARD_CAP) {
    // Show progress only once something resolved — an all-ran-out frame
    // would paint the tile as (wrong) solid interior.
    if (un.count < size * size) {
      post({
        type: "tile-progress",
        id,
        key,
        data: out.slice(),
        ranOut: un.count,
        iterDone: budget,
        maxFinite,
        costMs: performance.now() - t0,
      });
    }
    const next = Math.min(ITER_HARD_CAP, budget * ITER_ESCALATION);
    let write = 0;
    for (let i = 0; i < un.count; i++) {
      const idx = un.idx[i];
      const px = idx % size;
      const py = (idx / size) | 0;
      const cx = x0 + (px + 0.5) * step;
      const cy = y0 + (py + 0.5) * step;
      const v = orbit
        ? perturbPixel(cx, cy, orbit, next, un.n[i], un.ax[i], un.ay[i], un.m[i], bla, un.e2[i])
        : escapeTime(cx, cy, next, un.n[i], un.ax[i], un.ay[i], un.e2[i]);
      if (v === BAD_REF && !msg.noRescue) {
        if (bad.count === 0) {
          bad.dcx = cx;
          bad.dcy = cy;
        }
        bad.count++;
        out[idx] = 0;
      } else if (v < 0 && v !== BAD_REF) {
        un.idx[write] = idx;
        un.ax[write] = pixelState.ax;
        un.ay[write] = pixelState.ay;
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
    },
    [out.buffer]
  );
};

const handleReference = async (msg: ReferenceMsg): Promise<void> => {
  const { id, refId, cxFP, cyFP, bits, maxIter } = msg;
  const gen = referenceOrbit(cxFP, cyFP, bits, maxIter);
  let orbit: Float64Array;
  for (;;) {
    const step = gen.next();
    if (step.done) {
      orbit = step.value;
      break;
    }
    await tick();
    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({ type: "aborted", id, key: "" });
      return;
    }
  }
  post({ type: "reference", id, refId, orbit, cxFP, cyFP, bits }, [
    orbit.buffer,
  ]);
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
