// Zoom-movie export. The exploration cache already holds the expensive part
// of a zoom video (the escape-time fields along the corridor), so a movie is
// mostly compositing cached tiles and feeding a hardware encoder.
//
// The movie plays zoom-IN (whole set down to the current view), but tiles
// are produced zoom-OUT: deep levels are cache-hot from exploration and each
// shallower level's central region synthesizes from the children just used.
// Frames are therefore produced in segments walked deepest-first; within a
// segment the tile window is materialized first (deep level before shallow),
// then the segment's frames are rendered in forward playback order and
// encoded as a self-contained closed GOP. Each segment's compressed chunks
// spill to OPFS, and a final pass remuxes the segments in playback order,
// streaming the mp4 to a user-picked file — peak memory stays at one
// segment's tiles plus one raw frame, regardless of movie length or depth.

import {
  ArrayBufferTarget,
  FileSystemWritableFileStreamTarget,
  Muxer,
} from "mp4-muxer";
import { DeepCamera } from "./camera";
import { ExportTarget } from "./renderer";
import { EXPORT_SUPERSAMPLE, FractalViewer } from "./viewer";

const FPS = 60;
const LEVELS_PER_SEC = 2;
const SEGMENT_FRAMES = 30;
// Output long side. Fixed rather than screen-derived: it bounds the tile
// window (and so cache pressure) no matter the display, and decouples the
// movie from the monitor it was recorded on. 720p-class on purpose — it
// encodes ~2.3x faster than 1080p, computes ~2x fewer/shallower native
// tiles, and shifts the opportunistic supersample level onto exactly the
// tiles a 1920-wide screen's exploration cached.
const OUT_LONG_SIDE = 1280;
// Opening shot: the whole set, matching the default home view.
const START_ZOOM = 4;
const KEYFRAME_INTERVAL = 120; // frames; segment starts are always keyframes
const MAX_ENCODE_QUEUE = 8;
const OPFS_DIR = "fractile-export";

export type ExportProgress = {
  phase: "render" | "save";
  fraction: number;
};

export class ExportCancelledError extends Error {
  constructor() {
    super("export cancelled");
  }
}

type SaveFilePicker = (options?: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle>;

type ChunkRecord = {
  type: "key" | "delta";
  timestamp: number; // playback presentation time, microseconds
  duration: number;
  data: Uint8Array;
};

// Color-animation state captured at export time. The movie evaluates the
// same stepping math the live loop uses, but in VIDEO time — frame i sits at
// i/fps seconds — never wall-clock time. The live path accumulates a linear
// step per rAF (offset += rate * elapsed), so the closed form below
// reproduces it exactly while staying deterministic under the export's
// out-of-order segment production.
export type ColorAnimation = {
  bandOffset: number; // starting offsets (frame 0 = whole-set opening shot)
  hueOffset: number;
  bandDirection: number; // +1 | -1
  hueDirection: number;
  bandHueSpeed: number; // 0..1 band-vs-hue rate mix, as in the live control
  frameDuration: number; // ms per animation frame unit (60000 / speed)
};

export type ExportOptions = {
  fps?: number;
  levelsPerSec?: number;
  // When present, the movie's bandOffset/hueOffset animate along the video
  // timeline; when absent, frames use the style snapshot taken at exportBegin.
  colorAnimation?: ColorAnimation;
};

// Wrap into [-half, half), mirroring the live loop's numeric hygiene; the
// palette math is periodic so the wrap never changes the rendered color.
const wrapCentered = (v: number, half: number): number => {
  const period = 2 * half;
  return ((((v + half) % period) + period) % period) - half;
};

const serializeChunks = (chunks: ChunkRecord[]): Uint8Array<ArrayBuffer> => {
  let size = 0;
  for (const c of chunks) size += 21 + c.data.byteLength;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const c of chunks) {
    view.setUint32(at, c.data.byteLength);
    out[at + 4] = c.type === "key" ? 1 : 0;
    view.setFloat64(at + 5, c.timestamp);
    view.setFloat64(at + 13, c.duration);
    out.set(c.data, at + 21);
    at += 21 + c.data.byteLength;
  }
  return out;
};

const deserializeChunks = (buf: ArrayBuffer): ChunkRecord[] => {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const chunks: ChunkRecord[] = [];
  let at = 0;
  while (at < buf.byteLength) {
    const len = view.getUint32(at);
    chunks.push({
      type: bytes[at + 4] === 1 ? "key" : "delta",
      timestamp: view.getFloat64(at + 5),
      duration: view.getFloat64(at + 13),
      data: bytes.subarray(at + 21, at + 21 + len),
    });
    at += 21 + len;
  }
  return chunks;
};

// Segment chunk store: OPFS when available (constant RAM however long the
// movie), an in-memory map otherwise.
class SegmentStore {
  private dir: FileSystemDirectoryHandle | null = null;
  private ram = new Map<number, Uint8Array<ArrayBuffer>>();

  async init(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry(OPFS_DIR, { recursive: true });
      } catch {
        // No stale directory to clear.
      }
      this.dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    } catch {
      this.dir = null;
    }
  }

  async put(segment: number, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.dir) {
      this.ram.set(segment, bytes);
      return;
    }
    const handle = await this.dir.getFileHandle(`seg-${segment}.bin`, {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  }

  async get(segment: number): Promise<ArrayBuffer> {
    if (!this.dir) {
      const bytes = this.ram.get(segment);
      if (!bytes) throw new Error(`missing export segment ${segment}`);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
    }
    const handle = await this.dir.getFileHandle(`seg-${segment}.bin`);
    return (await handle.getFile()).arrayBuffer();
  }

  async dispose(): Promise<void> {
    this.ram.clear();
    if (this.dir) {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(OPFS_DIR, { recursive: true });
      } catch {
        // Best-effort cleanup.
      }
      this.dir = null;
    }
  }
}

const pickCodec = async (
  width: number,
  height: number,
  bitrate: number,
  fps: number
): Promise<string> => {
  for (const codec of ["avc1.640034", "avc1.640033", "avc1.64002A", "avc1.4D402A"]) {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
    });
    if (support.supported) return codec;
  }
  throw new Error("no supported H.264 encoder configuration");
};

export class VideoExporter {
  private aborted = false;
  private running = false;
  private fps: number;
  private levelsPerSec: number;
  private colorAnimation: ColorAnimation | null;

  constructor(private viewer: FractalViewer, opts: ExportOptions = {}) {
    this.fps = opts.fps ?? FPS;
    this.levelsPerSec = opts.levelsPerSec ?? LEVELS_PER_SEC;
    this.colorAnimation = opts.colorAnimation ?? null;
  }

  static isSupported(): boolean {
    return typeof VideoEncoder !== "undefined";
  }

  cancel(): void {
    this.aborted = true;
    // Wake any tile waits so the pipeline unwinds promptly.
    if (this.running) this.viewer.exportEnd();
  }

  private checkAborted(): void {
    if (this.aborted) throw new ExportCancelledError();
  }

  async run(onProgress: (p: ExportProgress) => void): Promise<void> {
    if (!VideoExporter.isSupported()) {
      throw new Error("video export needs WebCodecs (Chrome or Edge)");
    }

    // The save dialog must open while the click's user activation is live —
    // before any other awaits.
    const picker = (window as { showSaveFilePicker?: SaveFilePicker })
      .showSaveFilePicker;
    let fileHandle: FileSystemFileHandle | null = null;
    if (picker) {
      try {
        fileHandle = await picker.call(window, {
          suggestedName: "fractile-zoom.mp4",
          types: [
            { description: "MP4 video", accept: { "video/mp4": [".mp4"] } },
          ],
        });
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") {
          throw new ExportCancelledError();
        }
        throw e;
      }
    }

    const snap = this.viewer.exportBegin();
    this.running = true;
    const store = new SegmentStore();
    let target: ExportTarget | null = null;
    const openEncoders: VideoEncoder[] = [];
    let writable: FileSystemWritableFileStream | null = null;
    try {
      // Output dimensions: viewport aspect at a fixed long side, even for
      // yuv420. The zoom path shifts by the css-to-output scale so the
      // movie's field of view matches the screen's.
      const landscape = snap.cssW >= snap.cssH;
      const cssLong = landscape ? snap.cssW : snap.cssH;
      const scale = OUT_LONG_SIDE / cssLong;
      const outW = Math.max(2, Math.round(snap.cssW * scale) & ~1);
      const outH = Math.max(2, Math.round(snap.cssH * scale) & ~1);
      const zoomOffset = Math.log2(scale);
      const zEnd = snap.zoom + zoomOffset;
      const zStart = START_ZOOM + zoomOffset;
      if (zEnd <= zStart + 0.25) {
        throw new Error("zoom in first — the movie ends at your current view");
      }

      const fps = this.fps;
      const usOf = (frame: number): number =>
        Math.round((frame * 1e6) / fps);
      const step = this.levelsPerSec / fps;
      const totalFrames = Math.floor((zEnd - zStart) / step) + 1;
      // Anchor the END exactly on the current view; the first frame lands
      // within one step of the whole-set opening shot.
      const zoomOf = (i: number): number => zEnd - (totalFrames - 1 - i) * step;
      const camAt = (i: number): DeepCamera => {
        const cam = new DeepCamera();
        cam.setZoom(zoomOf(i));
        cam.setCenterFP(snap.cxFP, snap.cyFP, snap.bits);
        return cam;
      };
      // Animated color offsets for frame i, at i/fps seconds of VIDEO time —
      // the closed form of the live loop's accumulated per-rAF step. Pure in
      // the frame index: segments render deep-first and re-compose on
      // eviction races, so any dependence on production order or wall clock
      // would tear the animation.
      const anim = this.colorAnimation;
      const styleAt = (i: number): { bandOffset: number; hueOffset: number } => {
        const a = anim!;
        const framesPassed = (i * 1000) / fps / a.frameDuration;
        const bandSpeed = Math.min(1, (1 - a.bandHueSpeed) * 2);
        const hueSpeed = Math.min(1, a.bandHueSpeed * 2);
        return {
          bandOffset: wrapCentered(
            a.bandOffset + Math.PI * bandSpeed * a.bandDirection * framesPassed,
            Math.PI
          ),
          hueOffset: wrapCentered(
            a.hueOffset + 90 * hueSpeed * a.hueDirection * framesPassed,
            180
          ),
        };
      };

      const bitrate = Math.min(30e6, Math.round(outW * outH * fps * 0.1));
      const codec = await pickCodec(outW, outH, bitrate, fps);
      await store.init();
      target = this.viewer.exportCreateTarget(outW, outH);
      const pixels = new Uint8Array(outW * outH * 4);

      // Encoder pool. Segments are independent closed GOPs by construction,
      // so several VideoEncoder instances — each with its own codec thread —
      // encode different segments concurrently; without hardware encoding
      // this multiplies software throughput by roughly the pool size, and
      // the browser still picks a hardware encoder when one exists. Each
      // encoder runs its own monotonic production-timestamp line; chunks
      // map back to playback time through the per-encoder frame table.
      const ENCODER_POOL = Math.min(
        4,
        Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 4))
      );
      let description: Uint8Array | null = null;
      let encodeError: Error | null = null;
      type PooledEncoder = {
        encoder: VideoEncoder;
        chunks: ChunkRecord[];
        frameOf: number[];
        submitted: number;
      };
      const makeEncoder = (): PooledEncoder => {
        const enc: PooledEncoder = {
          encoder: null as unknown as VideoEncoder,
          chunks: [],
          frameOf: [],
          submitted: 0,
        };
        enc.encoder = new VideoEncoder({
          output: (chunk, meta) => {
            const desc = meta?.decoderConfig?.description;
            if (desc && !description) {
              description =
                desc instanceof ArrayBuffer
                  ? new Uint8Array(desc.slice(0))
                  : new Uint8Array(
                      (desc as ArrayBufferView).buffer.slice(
                        (desc as ArrayBufferView).byteOffset,
                        (desc as ArrayBufferView).byteOffset +
                          (desc as ArrayBufferView).byteLength
                      )
                    );
            }
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const prod = Math.round((chunk.timestamp * fps) / 1e6);
            enc.chunks.push({
              type: chunk.type as "key" | "delta",
              timestamp: usOf(enc.frameOf[prod]),
              duration: usOf(1),
              data,
            });
          },
          error: (e) => {
            encodeError = e as Error;
          },
        });
        enc.encoder.configure({
          codec,
          width: outW,
          height: outH,
          bitrate,
          framerate: fps,
          // Speed preset: the bitrate is generous enough that realtime
          // mode's efficiency loss is invisible, and it encodes ~1.5x
          // faster in software.
          latencyMode: "realtime",
          hardwareAcceleration: "no-preference",
          avc: { format: "avc" },
        });
        openEncoders.push(enc.encoder);
        return enc;
      };
      const idleEncoders: PooledEncoder[] = [];
      const encoderWaiters: Array<(e: PooledEncoder) => void> = [];
      let encodersMade = 0;
      const acquireEncoder = (): Promise<PooledEncoder> => {
        const free = idleEncoders.pop();
        if (free) return Promise.resolve(free);
        if (encodersMade < ENCODER_POOL) {
          encodersMade++;
          return Promise.resolve(makeEncoder());
        }
        return new Promise((resolve) => encoderWaiters.push(resolve));
      };
      const releaseEncoder = (enc: PooledEncoder): void => {
        const waiter = encoderWaiters.shift();
        if (waiter) waiter(enc);
        else idleEncoders.push(enc);
      };
      const pendingFlushes: Promise<void>[] = [];

      const segCount = Math.ceil(totalFrames / SEGMENT_FRAMES);

      // Segment s's frames sit at the END of production order (deep first),
      // and the next segment materializes while this one encodes, so
      // progress reports interleave — keep the bar monotone.
      let reported = 0;
      const report = (fraction: number): void => {
        reported = Math.max(reported, fraction);
        onProgress({ phase: "render", fraction: reported });
      };
      const nativeLevelOf = (s: number): number =>
        Math.round(zoomOf(Math.min(totalFrames, (s + 1) * SEGMENT_FRAMES) - 1));

      // One acquisition promise per tile for the whole export. A tile waits
      // only on its own four children (when they're part of the plan) before
      // acquiring — deep-first synthesis order per TILE rather than a
      // per-level barrier, so one slow straggler never idles the rest of
      // the worker pool.
      const acquired = new Map<string, Promise<void>>();
      const acquireTile = (
        level: number,
        tx: bigint,
        ty: bigint
      ): Promise<void> => {
        const k = `${level}:${tx}:${ty}`;
        let p = acquired.get(k);
        if (!p) {
          const deps: Promise<void>[] = [];
          for (let j = 0n; j <= 1n; j++) {
            for (let i = 0n; i <= 1n; i++) {
              const d = acquired.get(
                `${level + 1}:${tx * 2n + i}:${ty * 2n + j}`
              );
              if (d) deps.push(d.catch(() => undefined));
            }
          }
          p = (deps.length ? Promise.all(deps) : Promise.resolve()).then(() =>
            this.viewer.exportAcquire(level, tx, ty)
          );
          acquired.set(k, p);
        }
        return p;
      };

      // Materialize a segment's tile window. Native levels are computed
      // (deepest tiles first so shallower ones synthesize from fresh
      // children); the supersampled display level is only PINNED where
      // exploration already cached it — a free crispness dividend, never
      // a compute obligation.
      const materialize = async (s: number): Promise<void> => {
        const tMat = performance.now();
        const f0 = s * SEGMENT_FRAMES;
        const f1 = Math.min(totalFrames, f0 + SEGMENT_FRAMES);
        const segLen = f1 - f0;
        const prodBase = totalFrames - f1;
        const perLevel = new Map<number, Map<string, { tx: bigint; ty: bigint }>>();
        for (let i = f0; i < f1; i++) {
          const cam = camAt(i);
          const vis = cam.visibleTiles(outW, outH, 1);
          let tiles = perLevel.get(vis.level);
          if (!tiles) {
            tiles = new Map();
            perLevel.set(vis.level, tiles);
          }
          for (const t of vis.tiles) {
            tiles.set(`${t.tx}:${t.ty}`, { tx: t.tx, ty: t.ty });
          }
          const visS = cam.visibleTiles(outW, outH, EXPORT_SUPERSAMPLE);
          for (const t of visS.tiles) {
            this.viewer.exportPinIfCached(visS.level, t.tx, t.ty);
          }
        }
        const levels = [...perLevel.keys()].sort((a, b) => b - a);
        let tileTotal = 0;
        for (const tiles of perLevel.values()) tileTotal += tiles.size;
        let tilesDone = 0;
        const pending: Promise<void>[] = [];
        for (const level of levels) {
          for (const t of perLevel.get(level)!.values()) {
            pending.push(
              acquireTile(level, t.tx, t.ty).then(() => {
                tilesDone++;
                report(
                  (prodBase + segLen * 0.9 * (tilesDone / tileTotal)) /
                    totalFrames
                );
              })
            );
          }
        }
        await Promise.all(pending);
        console.debug(
          `export mat seg ${s} levels ${levels.join(",")} tiles ${tileTotal} ` +
            `${Math.round(performance.now() - tMat)}ms`
        );
      };

      const mats = new Map<number, Promise<void>>();
      const ensureMat = (s: number): Promise<void> => {
        let m = mats.get(s);
        if (!m) {
          m = materialize(s);
          mats.set(s, m);
        }
        return m;
      };

      for (let s = segCount - 1; s >= 0; s--) {
        this.checkAborted();
        // Two segments materialize concurrently: a straggling tile in this
        // segment leaves the rest of the worker pool filling the next one.
        // (The lookahead gets a no-op catch so an abort unwinding this loop
        // doesn't leave its rejection unhandled; the real await comes next
        // iteration.)
        ensureMat(s);
        if (s > 0) ensureMat(s - 1).catch(() => undefined);
        await ensureMat(s);
        const f0 = s * SEGMENT_FRAMES;
        const f1 = Math.min(totalFrames, f0 + SEGMENT_FRAMES);
        const segLen = f1 - f0;
        const prodBase = totalFrames - f1;

        // Compose the segment's frames in forward playback order and feed
        // them to a pooled encoder; the flush happens off the critical
        // path so the next segment composes into another encoder while
        // this one drains.
        const tEnc = performance.now();
        const enc = await acquireEncoder();
        for (let i = f0; i < f1; i++) {
          this.checkAborted();
          if (encodeError) throw encodeError;
          const cam = camAt(i);
          if (anim) this.viewer.exportSetStyle(styleAt(i));
          if (!this.viewer.exportComposeFrame(cam, target, pixels)) {
            // A tile slipped between materialize and compose (eviction
            // race); re-acquire this frame's native needs and take the
            // best of a second pass.
            const vis = cam.visibleTiles(outW, outH, 1);
            await Promise.all(
              vis.tiles.map((t) =>
                this.viewer.exportAcquire(vis.level, t.tx, t.ty)
              )
            );
            this.viewer.exportComposeFrame(cam, target, pixels);
          }
          const frame = new VideoFrame(pixels, {
            format: "RGBA",
            codedWidth: outW,
            codedHeight: outH,
            timestamp: usOf(enc.submitted),
            duration: usOf(1),
          });
          enc.frameOf[enc.submitted] = i;
          enc.submitted++;
          enc.encoder.encode(frame, {
            keyFrame: (i - f0) % KEYFRAME_INTERVAL === 0,
          });
          frame.close();
          report(
            (prodBase + segLen * (0.9 + 0.1 * ((i - f0 + 1) / segLen))) /
              totalFrames
          );
          if (enc.encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
            // Attach before re-checking: checking first races the final
            // dequeue event and can wait forever. An errored codec stops
            // firing dequeue entirely, so poll as a backstop and let the
            // loop's encodeError check surface the failure.
            await new Promise<void>((resolve) => {
              let timer = 0;
              const check = (): void => {
                if (
                  encodeError ||
                  enc.encoder.state !== "configured" ||
                  enc.encoder.encodeQueueSize <= MAX_ENCODE_QUEUE
                ) {
                  enc.encoder.removeEventListener("dequeue", check);
                  clearInterval(timer);
                  resolve();
                }
              };
              enc.encoder.addEventListener("dequeue", check);
              timer = window.setInterval(check, 250);
              check();
            });
          }
        }
        console.debug(
          `export enc seg ${s} submit ${Math.round(performance.now() - tEnc)}ms`
        );
        const flushJob = (async () => {
          await enc.encoder.flush();
          const chunks = enc.chunks;
          enc.chunks = [];
          await store.put(s, serializeChunks(chunks));
          releaseEncoder(enc);
          console.debug(
            `export flush seg ${s} done ${Math.round(performance.now() - tEnc)}ms`
          );
        })();
        // Suppress unhandled-rejection noise if an abort unwinds before the
        // Promise.all below; real failures still surface there.
        flushJob.catch(() => undefined);
        pendingFlushes.push(flushJob);
        // Release levels the rest of the movie can't use — the next
        // segment's levels and their synthesis children survive. (Safe
        // against the in-flight materialize: its levels are shallower.)
        if (s > 0) this.viewer.exportUnpinDeeper(nativeLevelOf(s - 1) + 1);
      }
      await Promise.all(pendingFlushes);
      if (encodeError) throw encodeError;
      for (const e of openEncoders) e.close();
      openEncoders.length = 0;
      if (!description) throw new Error("encoder produced no decoder config");

      // Remux to disk in playback order.
      onProgress({ phase: "save", fraction: 0 });
      let muxTarget: ArrayBufferTarget | FileSystemWritableFileStreamTarget;
      if (fileHandle) {
        writable = await fileHandle.createWritable();
        muxTarget = new FileSystemWritableFileStreamTarget(writable);
      } else {
        muxTarget = new ArrayBufferTarget();
      }
      const muxer = new Muxer({
        target: muxTarget,
        video: { codec: "avc", width: outW, height: outH },
        fastStart: false,
      });
      let first = true;
      for (let s = 0; s < segCount; s++) {
        this.checkAborted();
        for (const rec of deserializeChunks(await store.get(s))) {
          muxer.addVideoChunkRaw(
            rec.data,
            rec.type,
            rec.timestamp,
            rec.duration,
            first ? { decoderConfig: { codec, description } } : undefined
          );
          first = false;
        }
        onProgress({ phase: "save", fraction: (s + 1) / segCount });
      }
      muxer.finalize();
      if (writable) {
        await writable.close();
        writable = null;
      } else {
        const blob = new Blob([(muxTarget as ArrayBufferTarget).buffer], {
          type: "video/mp4",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "fractile-zoom.mp4";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (e) {
      // Cancellation unwinds through whatever await was in flight (tile
      // acquisition, encoder flush, ...) — surface it uniformly.
      if (this.aborted && !(e instanceof ExportCancelledError)) {
        throw new ExportCancelledError();
      }
      throw e;
    } finally {
      this.running = false;
      for (const e of openEncoders) {
        if (e.state !== "closed") e.close();
      }
      if (writable) {
        try {
          await writable.abort();
        } catch {
          // Already closed or errored.
        }
      }
      if (target) this.viewer.exportDeleteTarget(target);
      await store.dispose();
      this.viewer.exportEnd();
    }
  }
}
