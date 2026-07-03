// Persistent worker pool with a priority queue, cancellation, and reference-
// orbit management. One reference orbit (BigInt fixed-point, computed in a
// worker) is shared by every deep tile; tiles that need a reference park
// until it's ready. Correctness never depends on *which* reference a tile
// used (rebasing guarantees that), so replacing the reference never
// invalidates cached or in-flight tiles.

import { ITER_HARD_CAP } from "./camera";
import { fixedToFloat, rescale } from "./fixedPoint";

export type TileJob = {
  key: string;
  level: number;
  tx: bigint;
  ty: bigint;
  size: number;
  maxIter: number;
  needsRef: boolean;
  priority: number;
};

type Reference = {
  refId: number;
  cxFP: bigint;
  cyFP: bigint;
  bits: number;
  maxIter: number;
  status: "computing" | "ready";
};

type WorkerSlot = { w: Worker; taskId: number | null };
type InFlight = { key: string; workerIdx: number; job?: TileJob; isRef: boolean };

// Recompute the reference only when the view drifts this many pixels away —
// an efficiency threshold, not a correctness one.
const REF_MAX_DRIFT_PX = 8192;

export class FractalEngine {
  private workers: WorkerSlot[] = [];
  private queue = new Map<string, TileJob>();
  private parked = new Map<string, TileJob>();
  private inFlightByKey = new Map<string, number>();
  private inFlight = new Map<number, InFlight>();
  private nextId = 1;
  private nextRefId = 1;
  private ref: Reference | null = null;
  private refJobPending = false;

  constructor(
    private onTile: (
      key: string,
      data: Float32Array,
      iterDone: number,
      maxFinite: number,
      costMs: number,
      final: boolean
    ) => void,
    poolSize = Math.max(2, (navigator.hardwareConcurrency || 4) - 1)
  ) {
    for (let i = 0; i < poolSize; i++) {
      const w = new Worker(new URL("../mandelbrotWorker.ts", import.meta.url), {
        type: "module",
      });
      w.onmessage = (e) => this.handleMessage(i, e);
      this.workers.push({ w, taskId: null });
    }
  }

  destroy(): void {
    for (const slot of this.workers) slot.w.terminate();
    this.workers = [];
    this.queue.clear();
    this.parked.clear();
  }

  // Returns true if a suitable reference is ready. Otherwise starts (or keeps
  // waiting on) a computation and returns false; deep tile requests park in
  // the meantime and are released when the orbit arrives.
  ensureReference(
    cxFP: bigint,
    cyFP: bigint,
    bits: number,
    maxIter: number,
    pixelSize: number
  ): boolean {
    const r = this.ref;
    if (r) {
      const dx = fixedToFloat(rescale(cxFP, bits, r.bits) - r.cxFP, r.bits);
      const dy = fixedToFloat(rescale(cyFP, bits, r.bits) - r.cyFP, r.bits);
      const driftPx = Math.hypot(dx, dy) / pixelSize;
      // Orbit length is not part of suitability here: escaped references are
      // complete at any length, and truncated ones are extended on demand via
      // the worker's ref-short signal (wrapping a truncated orbit would be
      // numerically catastrophic, so workers park those pixels instead).
      const suitable = r.bits >= bits && driftPx < REF_MAX_DRIFT_PX;
      if (suitable && r.status === "ready") return true;
      if (r.status === "computing") return false;
      if (suitable) return true;
    }
    // Headroom so panning and one-level zooms don't churn the reference.
    this.ref = {
      refId: this.nextRefId++,
      cxFP,
      cyFP,
      bits,
      maxIter: Math.ceil(maxIter * 1.5) + 2048,
      status: "computing",
    };
    this.refJobPending = true;
    this.pump();
    return false;
  }

  requestTile(job: TileJob): void {
    if (this.inFlightByKey.has(job.key)) return;
    const queued = this.queue.get(job.key) ?? this.parked.get(job.key);
    if (queued) {
      queued.priority = job.priority;
      return;
    }
    if (job.needsRef && this.ref?.status !== "ready") {
      this.parked.set(job.key, job);
    } else {
      this.queue.set(job.key, job);
    }
    this.pump();
  }

  // Put a bounced job back: parked while a reference is computing (released
  // on completion), queued otherwise — never parked beside a ready reference,
  // which nothing would ever release.
  private requeue(job: TileJob): void {
    if (job.needsRef && this.ref?.status !== "ready") {
      this.parked.set(job.key, job);
    } else {
      this.queue.set(job.key, job);
    }
  }

  // Drop queued work and cancel in-flight work for tiles no longer wanted.
  retain(wanted: Set<string>): void {
    for (const key of this.queue.keys()) {
      if (!wanted.has(key)) this.queue.delete(key);
    }
    for (const key of this.parked.keys()) {
      if (!wanted.has(key)) this.parked.delete(key);
    }
    for (const [key, id] of this.inFlightByKey) {
      if (!wanted.has(key)) {
        const meta = this.inFlight.get(id);
        if (meta) this.workers[meta.workerIdx].w.postMessage({ type: "cancel", id });
      }
    }
  }

  private popBest(): TileJob | undefined {
    let best: TileJob | undefined;
    for (const job of this.queue.values()) {
      if (!best || job.priority < best.priority) best = job;
    }
    if (best) this.queue.delete(best.key);
    return best;
  }

  private pump(): void {
    for (let i = 0; i < this.workers.length; i++) {
      const slot = this.workers[i];
      if (slot.taskId !== null) continue;

      if (this.refJobPending && this.ref) {
        const id = this.nextId++;
        slot.taskId = id;
        this.inFlight.set(id, { key: "", workerIdx: i, isRef: true });
        slot.w.postMessage({
          type: "reference",
          id,
          refId: this.ref.refId,
          cxFP: this.ref.cxFP,
          cyFP: this.ref.cyFP,
          bits: this.ref.bits,
          maxIter: this.ref.maxIter,
        });
        this.refJobPending = false;
        continue;
      }

      const job = this.popBest();
      if (!job) break;
      const id = this.nextId++;
      slot.taskId = id;
      this.inFlightByKey.set(job.key, id);
      this.inFlight.set(id, { key: job.key, workerIdx: i, job, isRef: false });
      slot.w.postMessage({
        type: "tile",
        id,
        key: job.key,
        level: job.level,
        tx: job.tx,
        ty: job.ty,
        size: job.size,
        maxIter: job.maxIter,
        refId: job.needsRef ? this.ref?.refId ?? null : null,
      });
    }
  }

  private free(id: number): InFlight | undefined {
    const meta = this.inFlight.get(id);
    if (!meta) return undefined;
    this.inFlight.delete(id);
    this.workers[meta.workerIdx].taskId = null;
    if (!meta.isRef && this.inFlightByKey.get(meta.key) === id) {
      this.inFlightByKey.delete(meta.key);
    }
    return meta;
  }

  private handleMessage(_workerIdx: number, e: MessageEvent): void {
    const msg = e.data;
    switch (msg.type) {
      case "tile": {
        this.free(msg.id);
        this.onTile(msg.key, msg.data, msg.iterDone, msg.maxFinite, msg.costMs, true);
        this.pump();
        break;
      }

      // Provisional frame from a still-running adaptive escalation: display
      // it, but the worker slot stays busy and the job stays cancellable.
      case "tile-progress":
        this.onTile(msg.key, msg.data, msg.iterDone, msg.maxFinite, msg.costMs, false);
        break;

      case "aborted":
        this.free(msg.id);
        this.pump();
        break;

      case "no-ref": {
        // Worker's reference was evicted before this tile ran; requeue it.
        const meta = this.free(msg.id);
        if (meta?.job) this.requeue(meta.job);
        this.pump();
        break;
      }

      case "ref-short": {
        // The tile has pixels blocked on a budget-truncated reference orbit:
        // extend the reference and requeue the tile behind it. Once the
        // orbit escapes (or exceeds the pixel iteration cap) this can't
        // recur, so the extension cycle terminates.
        const meta = this.free(msg.id);
        const r = this.ref;
        if (r && r.status === "ready" && r.maxIter < ITER_HARD_CAP + 2048) {
          this.ref = {
            ...r,
            refId: this.nextRefId++,
            maxIter: Math.min(ITER_HARD_CAP + 2048, r.maxIter * 4),
            status: "computing",
          };
          this.refJobPending = true;
        }
        if (meta?.job) this.requeue(meta.job);
        this.pump();
        break;
      }

      case "reference": {
        this.free(msg.id);
        if (this.ref && msg.refId === this.ref.refId) {
          this.ref.status = "ready";
          for (const slot of this.workers) {
            slot.w.postMessage({
              type: "set-reference",
              refId: msg.refId,
              orbit: msg.orbit,
              cxFP: msg.cxFP,
              cyFP: msg.cyFP,
              bits: msg.bits,
            });
          }
          for (const [key, job] of this.parked) {
            this.queue.set(key, job);
          }
          this.parked.clear();
        }
        this.pump();
        break;
      }
    }
  }
}
