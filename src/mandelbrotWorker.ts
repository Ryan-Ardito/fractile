// Worker shim: message plumbing around the pure math in engine/mandelbrot.
// Long computations yield to the event loop between row bands so 'cancel'
// and 'set-reference' messages are processed mid-tile.

import {
  directRows,
  escapeTime,
  makeUnresolvedBuf,
  perturbPixel,
  perturbRows,
  pixelState,
  referenceOrbit,
} from "./engine/mandelbrot";
import {
  ITER_ESCALATION,
  ITER_HARD_CAP,
  RANOUT_PIXEL_THRESHOLD,
} from "./engine/camera";
import { fixedToFloat } from "./engine/fixedPoint";

type Reference = {
  orbit: Float64Array;
  cxFP: bigint;
  cyFP: bigint;
  bits: number;
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

type SetReferenceMsg = { type: "set-reference"; refId: number } & Reference;
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
  const out = new Float32Array(size * size);
  const un = makeUnresolvedBuf(size * size);

  // Perturbation setup (deep tiles); null means the direct float64 path.
  let orbit: Float64Array | null = null;
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
    orbit = ref.orbit;
    const shift = BigInt(ref.bits + 4 - level);
    const eight = 8n << BigInt(ref.bits);
    dcx0 = fixedToFloat((tx << shift) - eight - ref.cxFP, ref.bits);
    dcy0 = fixedToFloat((ty << shift) - eight - ref.cyFP, ref.bits);
  }
  const x0 = orbit ? dcx0 : Number(tx) * tileW - 8;
  const y0 = orbit ? dcy0 : Number(ty) * tileW - 8;

  // First pass at the requested budget, collecting unresolved pixel state.
  for (let row = 0; row < size; row += ROW_BAND) {
    const rowEnd = Math.min(row + ROW_BAND, size);
    if (orbit) {
      perturbRows(dcx0, dcy0, step, size, maxIter, orbit, row, rowEnd, out, un);
    } else {
      directRows(level, Number(tx), Number(ty), size, maxIter, row, rowEnd, out, un);
    }
    await tick();
    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({ type: "aborted", id, key });
      return;
    }
  }

  // Adaptive escalation: resume only the unresolved pixels with ever-larger
  // budgets until the tile is clean (few enough ran-out pixels), progress
  // stalls, or the hard cap is reached. Escaped/interior pixels are never
  // recomputed. Each round posts a provisional frame so deep tiles appear
  // progressively instead of blocking until fully converged.
  let maxFinite = maxFiniteOf(out);
  let budget = maxIter;
  while (un.count > RANOUT_PIXEL_THRESHOLD && budget < ITER_HARD_CAP) {
    post({
      type: "tile-progress",
      id,
      key,
      data: out.slice(),
      ranOut: un.count,
      iterDone: budget,
      maxFinite,
    });
    const next = Math.min(ITER_HARD_CAP, budget * ITER_ESCALATION);
    let write = 0;
    let resolved = 0;
    for (let i = 0; i < un.count; i++) {
      const idx = un.idx[i];
      const px = idx % size;
      const py = (idx / size) | 0;
      const cx = x0 + (px + 0.5) * step;
      const cy = y0 + (py + 0.5) * step;
      const v = orbit
        ? perturbPixel(cx, cy, orbit, next, budget, un.ax[i], un.ay[i], un.m[i])
        : escapeTime(cx, cy, next, budget, un.ax[i], un.ay[i]);
      if (v < 0) {
        un.idx[write] = idx;
        un.ax[write] = pixelState.ax;
        un.ay[write] = pixelState.ay;
        un.m[write] = pixelState.m;
        write++;
      } else {
        out[idx] = v;
        if (v > maxFinite) maxFinite = v;
        resolved++;
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
    // A whole 4x round that resolves nothing means the leftovers are
    // effectively interior at this location; more budget is wasted heat.
    if (resolved === 0) break;
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
