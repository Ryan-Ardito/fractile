// The tile map viewer: render loop, LRU tile cache with parent-tile fallback
// and fade-in, tile scheduling, and pointer/wheel/pinch input. Replaces
// OpenLayers with the same interaction feel, minus the float64 ceiling.

import {
  BASE_ITERATIONS,
  DeepCamera,
  ITER_ABS_CAP,
  ITER_ESCALATION,
  ITER_HARD_CAP,
  MAX_ZOOM,
  MIN_ZOOM,
  PERTURB_MIN_LEVEL,
  TILE_APRON,
  TILE_SIZE,
} from "./camera";
import { FractalEngine } from "./pool";
import { parseHash, serializeHash } from "./permalink";
import { ExportTarget, StyleVars, TileHandle, TileRenderer } from "./renderer";
import { fixedToFloat } from "./fixedPoint";

const TILE_CACHE_MAX = 768;
const FADE_MS = 200;
const MOVEEND_IDLE_MS = 260;
const ZOOM_EASE_MS = 90;
const WHEEL_ZOOM_PER_100 = 1;
const INERTIA_DECAY_MS = 300;
// Inertia only engages if the pointer was still moving this recently at
// release — a drag that pauses before letting go must not coast.
const INERTIA_STALE_MS = 60;
const VELOCITY_WINDOW_MS = 100;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

// Keep per-frame main-thread work bounded: cap GPU texture uploads per frame
// and cap ancestor walks (the base grid is checked directly past the cap).
const MAX_UPLOADS_PER_FRAME = 4;
const MAX_FALLBACK_WALK = 16;
const MAX_ANCESTOR_TOUCH = 48;

// Iteration-need prediction: the escape-time field is continuous, so a tile's
// observed max finite escape count (plus margin) is what its neighbors and
// children will need. Workers self-escalate past a bad guess in-job, so the
// margin only trades a little compute for fewer escalation rounds.
const ITER_NEED_MARGIN = 1.5;
const ITER_NEED_PAD = 256;

// Tiles at or below this level are never evicted while unprotected tiles
// remain — they are the zoom-out backdrop.
const BASE_PROTECT_LEVEL = 6;
// The level whose full world grid is always kept computed so the background
// never shows through.
const BASE_GRID_LEVEL = 3;
const PRELOAD_PRIORITY = 1e12;
// The base grid is 64 cheap tiles and the fallback of last resort — compute
// it before anything else so a fresh deep load never shows the background.
const BASE_GRID_PRIORITY = -1;

// Zoom-out prewarm: once the view is idle, spend spare worker time computing
// viewport-sized tile windows at ancestor levels, nearest level first (those
// are the expensive ones; far-shallower levels recompute in milliseconds if
// missed). The budget caps both the compute and the cache footprint it pins.
const PREWARM_PRIORITY = 1e13;
const PREWARM_TILE_BUDGET = 384;

// Idle refinement: the escalation ladder's wall-clock guard stops tiles
// honestly with unresolved (black) pixels below the iteration cap — but a
// parked view with idle workers should keep chasing the ideal ("every tile
// at infinite iterations") instead of freezing there. When the engine
// drains, visible tiles that still hold sub-cap unresolved pixels are
// re-requested at the next escalation rung, at a priority below everything
// else; any camera movement cancels the in-flight passes immediately (their
// row/chunk loops poll cancellation), so the pool is never busy when
// interaction needs it.
const IDLE_REFINE_PRIORITY = 1e14;
const IDLE_REFINE_REPLAN_MS = 1500;

// Interactive iteration cap. The debug override (__fractileCapBase) exists
// to test the cap-escalation machinery at scaled-down constants — a view
// where the REAL 2^22 cap binds needs extreme depth.
const capBase = (): number =>
  (globalThis as { __fractileCapBase?: number }).__fractileCapBase ??
  ITER_HARD_CAP;
// Ceiling idle refinement may reach: 16x the interactive cap (= ITER_ABS_CAP
// at production constants).
const refineCeil = (): number => Math.min(ITER_ABS_CAP, capBase() * 16);

// Video export: frames prefer tiles one level deeper than the output
// resolution needs (2x supersampling via the level-selection bias in
// visibleTiles) — but only where those tiles are already cached from
// exploration. Computing the corridor happens at native level; the
// supersample is a cache dividend, never a compute obligation (fresh
// corridors would otherwise cost 4-8x the pixels). Export tiles rank just
// above the parent-preload/prewarm background but below visible tiles —
// the screen stays filled first (visible requests are few; the refinement
// ladders that once starved exports are paused during a session).
export const EXPORT_SUPERSAMPLE = 2;
const EXPORT_PRIORITY = 2e6;
// Export tile budget: exactly the screen's own first-pass curve, floors
// and parent inheritance excluded. A zoom movie spends ~half a second per
// level — the pace of a brisk dive, where the screen shows first-pass
// quality and cancels refinement as the user moves on. Every attempt to
// aim higher backfired measurably: learned floors and cached-parent
// budgets are dominated by rare deep escapes the flash-by can't show, the
// worker's first pass has no wall-clock guard (floor-sized budgets on
// near-parabolic minibrot shells ran 13-18s per tile), and ladder rungs
// past the first pass quadruple that. One bounded pass, accepted at its
// first commit, ladder cancelled. The climax is unaffected: the current
// view's tiles are cached from the screen at full refined quality.

// First response for a tile whose best on-screen stand-in would be an
// ancestor stretched 8x or worse (deep jumps, fast zooms): a quarter-cost
// 128x128 pass at the CORRECT level, upgraded to full resolution by the
// normal provisional path. Correct-level data at 2x stretch arrives ~4x
// sooner and looks far better than deep-stretched mush.
const COARSE_TILE_SIZE = 128;

type CacheEntry = {
  tex: TileHandle;
  // The texture this entry replaced, drawn at full opacity beneath while the
  // new one fades in — upgrades (coarse to full, escalation frames) blend
  // instead of popping. Freed once the fade completes.
  prevTex: TileHandle | null;
  loadedAt: number;
  maxIter: number;
  // Largest finite escape count observed in the tile — the measured
  // "no visual improvement above this" bound used to seed related tiles.
  maxFinite: number;
  // True when this texture is a provisional escalation frame whose job was
  // never seen to finish — re-request it if it comes back into view.
  needsMore: boolean;
  level: number;
  // Worker-measured compute cost (ms). Eviction sacrifices cheap tiles first,
  // so an expensive deep corridor survives a trip to shallow water and back.
  cost: number;
  // Pixels still unresolved (neither escaped nor interior-certified) at
  // maxIter — the idle-refinement candidates. Synthesized tiles inherit the
  // worst of their children.
  ranOut: number;
  // Built by GPU subsampling of children rather than computed (refGen 0 is
  // NOT a synth marker: direct-path tiles carry it too).
  synth: boolean;
  // Reference GENERATION the tile was computed under (0 = direct path or
  // synthesized). Chaos-class content visibly disagrees across generations
  // (correlated rounding drift becomes broad brightness shifts after the
  // palette log-remap), so visible finals from a stale generation are
  // re-leveled to the active one. Same-center extensions share a generation.
  refGen: number;
};
type ViewerEvent = "moveend";

const levelOfKey = (key: string): number => parseInt(key, 10);

export class FractalViewer {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: TileRenderer;
  private camera: DeepCamera;
  private engine: FractalEngine;
  private cache = new Map<string, CacheEntry>();
  // Highest iteration count adaptively reached per level; new tiles start here.
  private iterFloor = new Map<number, number>();
  private baseGridTiles: Array<{ key: string; tx: bigint; ty: bigint }> = [];
  // Tiles the current view considers relevant (visible + parents + base grid
  // + prewarm corridor) as of the last render — eviction spares these.
  private lastWanted = new Set<string>();
  // The planned zoom-out corridor; recomputed at each moveend.
  private prewarmKeys = new Set<string>();
  // The central-column subset of the corridor (one tile per ancestor level,
  // straight up): the most protected cache tier — breadth goes first.
  private centerKeys = new Set<string>();
  private lastLevel = 0;

  private raf = 0;
  private dirty = true;
  private destroyed = false;
  private lastFrameAt = 0;

  private moved = false;
  private lastMoveAt = 0;
  private listeners: Record<ViewerEvent, Array<() => void>> = { moveend: [] };

  private targetZoom: number;
  private zoomAnchor: { x: number; y: number } | null = null;
  private inertia: { vx: number; vy: number } | null = null;

  private pointers = new Map<number, { x: number; y: number }>();
  private lastDrag: { x: number; y: number; dist: number } | null = null;
  private dragSamples: Array<{ t: number; x: number; y: number }> = [];
  // Pointer deltas accumulate here and apply once per frame — high-rate mice
  // fire several moves per frame and must not do camera math per event.
  private pendingPanX = 0;
  private pendingPanY = 0;
  // Tile results wait here and upload a few per frame to avoid hitches.
  private pendingTiles = new Map<
    string,
    {
      data: Float32Array;
      iterDone: number;
      maxFinite: number;
      cost: number;
      final: boolean;
      refGen: number;
      ranOut: number;
    }
  >();
  private lastRefinePlanAt = 0;
  // Keys issued by the idle planner (refinement + children) — kept in the
  // wanted set so retain() doesn't cancel them at the next repaint.
  private idleKeys = new Set<string>();
  private canvasRect: DOMRect | null = null;
  private pinch: { dist: number; zoom: number } | null = null;
  private lastTap: { x: number; y: number; t: number } | null = null;
  private boxStart: { x: number; y: number } | null = null;
  private boxEl: HTMLDivElement | null = null;

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private resizeObserver: ResizeObserver;

  // Video export session state. Pinned tiles are exempt from eviction and
  // kept in the engine's wanted set (so retain() never cancels their jobs);
  // waiters resolve on any commit of their key so exportAcquire can poll
  // for a final full-resolution tile.
  private exportActive = false;
  private exportPinned = new Set<string>();
  private tileWaiters = new Map<string, Array<() => void>>();
  private exportRef: { cxFP: bigint; cyFP: bigint; bits: number } | null = null;
  // Per-level acquisition census for the current export session (also
  // exposed as window.__fractileExportStats for console diagnosis).
  private exportStats: Record<
    number,
    { n: number; hit: number; synth: number; waitMs: number; costMs: number }
  > = {};

  constructor(container: HTMLElement, initialHash?: string) {
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);

    this.renderer = new TileRenderer(this.canvas);
    this.renderer.setStyle({
      iterFalloff: 1 / 24,
      paletteScale: 1,
      hueOffset: 0,
      bandSpacing: 1 / 8,
      bandContrast: 0.28,
      bandOffset: 0,
      saturation: 0.8,
      lightness: 1,
    });
    this.camera = new DeepCamera();
    if (initialHash) {
      try {
        const state = parseHash(initialHash);
        this.camera.setZoom(state.zoom);
        this.camera.setCenterFP(state.cxFP, state.cyFP, state.bits);
      } catch {
        // Malformed hash: keep the default view.
      }
    }
    this.targetZoom = this.camera.zoom;
    // Emit an initial moveend (as OpenLayers did on first render); the React
    // shell relies on it to arm its permalink updater.
    this.moved = true;
    this.lastMoveAt = performance.now();

    this.engine = new FractalEngine(
      (key, data, iterDone, maxFinite, cost, final, refGen, ranOut) =>
        this.onTile(key, data, iterDone, maxFinite, cost, final, refGen, ranOut)
    );

    const baseTiles = 1n << BigInt(BASE_GRID_LEVEL);
    for (let i = 0n; i < baseTiles; i++) {
      for (let j = 0n; j < baseTiles; j++) {
        this.baseGridTiles.push({
          key: this.tileKey(BASE_GRID_LEVEL, i, j),
          tx: i,
          ty: j,
        });
      }
    }

    this.resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) {
        this.cssW = rect.width || 1;
        this.cssH = rect.height || 1;
      }
      this.canvasRect = null;
      this.syncBackingStore();
      this.dirty = true;
    });
    this.resizeObserver.observe(container);
    // One-time layout read at startup; afterwards the observer keeps us
    // current and the render loop never touches layout.
    this.cssW = container.clientWidth || 1;
    this.cssH = container.clientHeight || 1;
    this.syncBackingStore();

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.exportActive) this.exportEnd();
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.engine.destroy();
    this.pendingTiles.clear();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.boxEl?.remove();
    this.canvas.remove();
  }

  // --- public API used by the React shell ---

  on(event: ViewerEvent, cb: () => void): void {
    this.listeners[event].push(cb);
  }

  off(event: ViewerEvent, cb: () => void): void {
    const arr = this.listeners[event];
    const i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  }

  updateStyleVariables(vars: Partial<StyleVars>): void {
    this.renderer.setStyle(vars);
    this.dirty = true;
  }

  panPixels(dx: number, dy: number): void {
    this.camera.panPixels(dx, dy);
    this.onCameraMove();
  }

  getHash(): string {
    return serializeHash({
      zoom: this.camera.zoom,
      bits: this.camera.bits,
      cxFP: this.camera.cxFP,
      cyFP: this.camera.cyFP,
    });
  }

  // Throws on malformed input; caller decides whether to ignore.
  applyHash(hash: string): void {
    const state = parseHash(hash);
    this.camera.setZoom(state.zoom);
    this.camera.setCenterFP(state.cxFP, state.cyFP, state.bits);
    this.targetZoom = this.camera.zoom;
    this.zoomAnchor = null;
    this.inertia = null;
    this.onCameraMove();
  }

  // --- video export session (see engine/export.ts for the pipeline) ---

  // Snapshot the view and switch the cache into export mode: the prewarm
  // corridor's protection is released in favor of the export window, and
  // planPrewarm stays quiet until the session ends.
  exportBegin(): {
    zoom: number;
    cxFP: bigint;
    cyFP: bigint;
    bits: number;
    cssW: number;
    cssH: number;
  } {
    this.exportActive = true;
    // Freeze the movie's colors: export frames colorize through a snapshot
    // of the current style (plus the exporter's per-frame animated offsets),
    // so live style changes during the render can't leak into the video.
    this.renderer.beginExportStyle();
    this.exportRef = {
      cxFP: this.camera.cxFP,
      cyFP: this.camera.cyFP,
      bits: this.camera.bits,
    };
    this.prewarmKeys.clear();
    this.centerKeys.clear();
    this.exportStats = {};
    (globalThis as Record<string, unknown>).__fractileExportStats =
      this.exportStats;
    // Diagnostic (console): what an in-progress export is waiting on.
    (globalThis as Record<string, unknown>).__fractileExportDebug = () => ({
      pinned: this.exportPinned.size,
      waiting: [...this.tileWaiters.keys()],
      cacheSize: this.cache.size,
      pendingTiles: [...this.pendingTiles.keys()],
      engine: this.engine.debugState(),
    });
    return {
      zoom: this.camera.zoom,
      cxFP: this.camera.cxFP,
      cyFP: this.camera.cyFP,
      bits: this.camera.bits,
      cssW: this.cssW,
      cssH: this.cssH,
    };
  }

  // Override style variables for subsequent export frames (animated color
  // offsets, evaluated by the exporter in video time). Touches only the
  // export style slot — the live view is unaffected.
  exportSetStyle(vars: Partial<StyleVars>): void {
    this.renderer.setExportStyle(vars);
  }

  exportEnd(): void {
    this.exportActive = false;
    this.exportRef = null;
    this.exportPinned.clear();
    // Close the export style slot and free its per-tile colorizations.
    // (exportEnd can run twice — cancel() and the pipeline's finally — so
    // everything here is idempotent.)
    this.renderer.endExportStyle();
    for (const entry of this.cache.values()) {
      this.renderer.dropExportColor(entry.tex);
      if (entry.prevTex) this.renderer.dropExportColor(entry.prevTex);
    }
    // Wake every waiter; exportAcquire re-checks exportActive and bails.
    const waiters = [...this.tileWaiters.values()];
    this.tileWaiters.clear();
    for (const arr of waiters) for (const w of arr) w();
    if (!this.destroyed) this.planPrewarm();
    this.dirty = true;
  }

  // Pin a tile and resolve once a movie-quality version is cached: any
  // finished job, or a provisional frame at the movie's budget for this
  // level (see the budget comment above EXPORT_PRIORITY). Meeting it
  // mid-ladder accepts early and cancels the rest of the job. Synthesis
  // (including the upgrade path) is tried on every look: the export walks
  // deepest-first exactly so each level's central region — where a deep
  // destination's high iteration needs live — inherits refined data from
  // its children for free instead of recomputing it starved.
  async exportAcquire(level: number, tx: bigint, ty: bigint): Promise<void> {
    const key = this.tileKey(level, tx, ty);
    this.exportPinned.add(key);
    const base =
      BASE_ITERATIONS * Math.max(1, Math.min(level, PERTURB_MIN_LEVEL));
    const target = base;
    const tAcq = performance.now();
    let firstLook = true;
    for (;;) {
      if (!this.exportActive) throw new Error("export session ended");
      let entry = this.cache.get(key);
      if (this.trySynthesize(level, tx, ty, true)) {
        entry = this.cache.get(key);
      }
      if (
        entry &&
        entry.tex.size >= TILE_SIZE &&
        (!entry.needsMore || entry.maxIter >= target)
      ) {
        // Good enough for the movie — the view's own "no visual
        // improvement above the measured bound" standard. If a job is
        // still laddering toward the cap, free the worker; the entry
        // stays needsMore so the interactive view can resume it later.
        if (entry.needsMore) this.engine.cancelTile(key);
        this.touch(key);
        const st = (this.exportStats[level] ??= {
          n: 0, hit: 0, synth: 0, waitMs: 0, costMs: 0,
        });
        st.n++;
        if (firstLook) st.hit++;
        if (entry.cost <= 0.1) st.synth++;
        st.waitMs += performance.now() - tAcq;
        st.costMs += entry.cost;
        return;
      }
      firstLook = false;
      const needsRef = level >= PERTURB_MIN_LEVEL;
      if (needsRef && this.exportRef) {
        // The export corridor shares the view's reference machinery; pixel
        // size passed in exponent parts for this tile's level.
        this.engine.ensureReference(
          this.exportRef.cxFP,
          this.exportRef.cyFP,
          this.exportRef.bits,
          this.baseIter(level),
          1,
          -(level + 4)
        );
      }
      this.engine.requestTile({
        key,
        level,
        tx,
        ty,
        size: TILE_SIZE,
        maxIter: base,
        needsRef,
        priority: EXPORT_PRIORITY,
      });
      await new Promise<void>((resolve) => {
        const arr = this.tileWaiters.get(key);
        if (arr) arr.push(resolve);
        else this.tileWaiters.set(key, [resolve]);
      });
    }
  }

  // Pin a tile only if it's already cached — used for the supersampled
  // display level, which is drawn when exploration already paid for it but
  // never computed for the export's sake.
  exportPinIfCached(level: number, tx: bigint, ty: bigint): void {
    const key = this.tileKey(level, tx, ty);
    if (this.cache.has(key)) {
      this.exportPinned.add(key);
      this.touch(key);
    }
  }

  // Drop pins deeper than maxLevel — the zoom-out export walks shallower,
  // so deeper levels' pins are released once their synthesis role is done.
  exportUnpinDeeper(maxLevel: number): void {
    for (const key of this.exportPinned) {
      if (levelOfKey(key) > maxLevel) this.exportPinned.delete(key);
    }
  }

  exportCreateTarget(w: number, h: number): ExportTarget {
    return this.renderer.createExportTarget(w, h);
  }

  exportDeleteTarget(target: ExportTarget): void {
    this.renderer.deleteExportTarget(target);
  }

  // Compose one export frame from cache into the target and read it back
  // top-down into out (RGBA). Tiles are addressed at the supersampled
  // level and drawn from cache when exploration already computed them;
  // everything else falls back one level to the native tiles the export
  // materialized (screen quality). Returns false only when a tile had to
  // fall back deeper than that — the caller re-acquires and retries.
  // Fully synchronous: nothing may interleave between beginExport and
  // readExport.
  exportComposeFrame(
    cam: DeepCamera,
    target: ExportTarget,
    out: Uint8Array
  ): boolean {
    const vis = cam.visibleTiles(target.w, target.h, EXPORT_SUPERSAMPLE);
    this.renderer.beginExport(target);
    let complete = true;
    for (const t of vis.tiles) {
      const entry = this.cache.get(this.tileKey(vis.level, t.tx, t.ty));
      if (entry && entry.tex.size >= TILE_SIZE) {
        this.renderer.drawTile(
          entry.tex, t.x, t.y, vis.tilePx, vis.tilePx, 0, 0, 1, 1, 1
        );
        continue;
      }
      const pick = this.pickFallback(vis.level, t.tx, t.ty);
      if (pick) this.drawFallbackPick(t.tx, t.ty, t.x, t.y, vis.tilePx, pick);
      if (!pick || pick.d > 1) complete = false;
    }
    this.renderer.readExport(target, out);
    return complete;
  }

  // --- internals ---

  private onCameraMove(): void {
    this.moved = true;
    this.lastMoveAt = performance.now();
    this.dirty = true;
    // Interaction reclaims the pool instantly: idle-refinement passes can
    // legally run long (they are only ever scheduled into dead time), so
    // they must die the moment the camera moves — and their queued keys
    // stop being retained so the next repaint's retain() drops them.
    this.idleKeys.clear();
    this.engine.cancelAtOrAbove(IDLE_REFINE_PRIORITY);
  }

  // Resizes the canvas backing store from cached CSS size + current dpr.
  // Reads no layout (devicePixelRatio is layout-free), so it's frame-safe.
  private syncBackingStore(): void {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private frame = (now: number): void => {
    if (this.destroyed) return;
    const dt = Math.min(50, now - this.lastFrameAt || 16);
    this.lastFrameAt = now;
    let animating = false;

    if (this.pendingPanX !== 0 || this.pendingPanY !== 0) {
      this.camera.panPixels(this.pendingPanX, this.pendingPanY);
      this.pendingPanX = 0;
      this.pendingPanY = 0;
      this.onCameraMove();
    }

    // Drain a few queued tile results per frame; spreading uploads out keeps
    // frame times level while tiles stream in during zooms.
    if (this.pendingTiles.size > 0) {
      let uploads = 0;
      for (const [key, tile] of this.pendingTiles) {
        if (uploads >= MAX_UPLOADS_PER_FRAME) break;
        this.pendingTiles.delete(key);
        this.commitTile(
          key,
          tile.data,
          tile.iterDone,
          tile.maxFinite,
          tile.cost,
          tile.final,
          tile.refGen,
          tile.ranOut
        );
        uploads++;
      }
      this.dirty = true;
    }

    if (this.targetZoom !== this.camera.zoom) {
      const diff = this.targetZoom - this.camera.zoom;
      if (Math.abs(diff) < 0.001) {
        this.camera.zoomTo(
          this.targetZoom,
          this.zoomAnchor?.x ?? 0,
          this.zoomAnchor?.y ?? 0
        );
        this.zoomAnchor = null;
      } else {
        const k = 1 - Math.exp(-dt / ZOOM_EASE_MS);
        this.camera.zoomTo(
          this.camera.zoom + diff * k,
          this.zoomAnchor?.x ?? 0,
          this.zoomAnchor?.y ?? 0
        );
        animating = true;
      }
      this.onCameraMove();
    }

    if (this.inertia) {
      const decay = Math.exp(-dt / INERTIA_DECAY_MS);
      this.camera.panPixels(this.inertia.vx * dt, this.inertia.vy * dt);
      this.inertia.vx *= decay;
      this.inertia.vy *= decay;
      if (Math.hypot(this.inertia.vx, this.inertia.vy) < 0.005) {
        this.inertia = null;
      } else {
        animating = true;
      }
      this.onCameraMove();
    }

    if (this.dirty || animating) {
      this.dirty = false;
      this.render(now);
    }

    if (
      this.moved &&
      !animating &&
      this.pointers.size === 0 &&
      now - this.lastMoveAt > MOVEEND_IDLE_MS
    ) {
      this.moved = false;
      this.planPrewarm();
      for (const cb of this.listeners.moveend) cb();
    }

    // Idle refinement: everything drained (corridor, dive cone, visible
    // work) and the view at rest — spend the spare workers pushing visible
    // unresolved pixels toward the iteration cap. Replanning is cheap and
    // idempotent; each pass advances tiles one escalation rung, so a parked
    // view converges toward the "infinite iterations" ideal on its own.
    if (
      !this.moved &&
      !animating &&
      !this.exportActive &&
      this.pointers.size === 0 &&
      this.pendingTiles.size === 0 &&
      now - this.lastRefinePlanAt > IDLE_REFINE_REPLAN_MS &&
      this.engine.isIdle()
    ) {
      this.lastRefinePlanAt = now;
      this.planIdleRefine();
    }

    this.raf = requestAnimationFrame(this.frame);
  };

  private tileKey(level: number, tx: bigint, ty: bigint): string {
    return `${level}:${tx}:${ty}`;
  }

  private touch(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  // Starting iteration count for a level: the legacy curve (capped at the
  // perturbation threshold) or whatever the adaptive system has already
  // learned this view needs at this depth.
  private baseIter(level: number): number {
    return Math.max(
      BASE_ITERATIONS * Math.max(1, Math.min(level, PERTURB_MIN_LEVEL)),
      this.iterFloor.get(level) ?? 0,
      this.iterFloor.get(level - 1) ?? 0,
      this.iterFloor.get(level - 2) ?? 0
    );
  }

  // Plan the zoom-out corridor in two passes: first the CENTRAL tile at
  // every ancestor level all the way up (a zoom-out is anchored at the
  // screen center, so this guarantees the middle of the view is sharp at
  // every level however far out the user flies), then viewport-sized
  // windows around the center with whatever budget remains, nearest level
  // first. Requested at prewarm priority, so workers only pick them up when
  // nothing interactive is queued; render() keeps the keys in the wanted
  // set, and the next moveend replans (which also cancels any
  // no-longer-relevant queued prewarm work via retain).
  private planPrewarm(): void {
    // While exporting, spare worker time and cache belong to the export
    // window; the corridor replans at the first moveend after the session.
    if (this.exportActive) return;
    this.prewarmKeys.clear();
    this.centerKeys.clear();
    const vis = this.camera.visibleTiles(this.cssW, this.cssH, this.dpr);
    const halfX = Math.ceil(((this.cssW * this.dpr) / TILE_SIZE + 1) / 2);
    const halfY = Math.ceil(((this.cssH * this.dpr) / TILE_SIZE + 1) / 2);
    const eight = 8n << BigInt(this.camera.bits);
    let budget = PREWARM_TILE_BUDGET;

    const addTile = (
      level: number,
      dx: number,
      dy: number,
      priority: number
    ): void => {
      const shift = BigInt(this.camera.bits + 4 - level);
      const tx = ((this.camera.cxFP + eight) >> shift) + BigInt(dx);
      const ty = ((this.camera.cyFP + eight) >> shift) + BigInt(dy);
      const maxTile = (1n << BigInt(level)) - 1n;
      if (tx < 0n || ty < 0n || tx > maxTile || ty > maxTile) return;
      const key = this.tileKey(level, tx, ty);
      if (this.prewarmKeys.has(key)) return;
      this.prewarmKeys.add(key);
      budget--;
      this.trySynthesize(level, tx, ty);
      if (this.cache.has(key) || this.pendingTiles.has(key)) return;
      this.engine.requestTile({
        key,
        level,
        tx,
        ty,
        size: TILE_SIZE,
        maxIter: this.tileIter(level, tx, ty, this.baseIter(level)),
        iterCap: capBase(),
        needsRef: level >= PERTURB_MIN_LEVEL,
        priority,
      });
    };

    // Pass 1: the central column, depth-first to the base grid.
    for (let d = 2; budget > 0; d++) {
      const level = vis.level - d;
      if (level <= BASE_GRID_LEVEL) break;
      addTile(level, 0, 0, PREWARM_PRIORITY + d * 1e6);
      const shift = BigInt(this.camera.bits + 4 - level);
      this.centerKeys.add(
        this.tileKey(
          level,
          (this.camera.cxFP + eight) >> shift,
          (this.camera.cyFP + eight) >> shift
        )
      );
    }
    // Pass 2: breadth around the center, nearest level first. Window tiles
    // rank strictly after every column tile.
    for (let d = 2; budget > 0; d++) {
      const level = vis.level - d;
      if (level <= BASE_GRID_LEVEL) break;
      for (let dy = -halfY; dy <= halfY && budget > 0; dy++) {
        for (let dx = -halfX; dx <= halfX && budget > 0; dx++) {
          addTile(
            level,
            dx,
            dy,
            PREWARM_PRIORITY + 1e10 + d * 1e9 + (dx * dx + dy * dy)
          );
        }
      }
    }
  }

  // If a tile is entirely covered by its four cached children, build it by
  // GPU-subsampling them instead of computing it — microseconds instead of
  // a worker job. Synthesized tiles carry near-zero cost, so eviction sheds
  // them first; resynthesis is nearly free while the children live.
  //
  // This is also an UPGRADE path, not just a miss path: children carry the
  // refined truth outward from a deep view, and a cached tile computed at
  // a starved budget (black centers around minibrots) must not block it.
  // An existing tile is replaced when the children's floor beats it by a
  // full escalation rung (4x) — the starvation signature — or by anything
  // at all while it is still provisional; equal-quality neighbors differ
  // only by noise and never churn. Because upgrades re-fire as children
  // improve, refinement propagates level by level toward the surface.
  //
  // allowProvisional (export only): accept full-size children that are
  // still refining; the result inherits needsMore so the view upgrades it.
  private trySynthesize(
    level: number,
    tx: bigint,
    ty: bigint,
    allowProvisional = false
  ): boolean {
    const kids: CacheEntry[] = [];
    for (let j = 0n; j <= 1n; j++) {
      for (let i = 0n; i <= 1n; i++) {
        const kid = this.cache.get(
          this.tileKey(level + 1, tx * 2n + i, ty * 2n + j)
        );
        if (!kid || kid.tex.size < TILE_SIZE) return false;
        if (kid.needsMore && !allowProvisional) return false;
        kids.push(kid);
      }
    }
    const synthIter = Math.min(...kids.map((k) => k.maxIter));
    const key = this.tileKey(level, tx, ty);
    const existing = this.cache.get(key);
    if (existing && existing.tex.size >= TILE_SIZE) {
      const required = existing.needsMore
        ? existing.maxIter + 1
        : existing.maxIter * 4;
      if (synthIter < required) return false;
    }
    const tex = this.renderer.synthesizeTile([
      kids[0].tex,
      kids[1].tex,
      kids[2].tex,
      kids[3].tex,
    ]);
    if (!tex) return false;
    // Diagnostic: visible in the console as window.__fractileSynth.
    (globalThis as { __fractileSynth?: number }).__fractileSynth =
      ((globalThis as { __fractileSynth?: number }).__fractileSynth ?? 0) + 1;
    if (existing?.prevTex) this.renderer.deleteTile(existing.prevTex);
    this.cache.set(key, {
      tex,
      // Replacements fade in over the outgoing texture like any commit.
      prevTex: existing ? existing.tex : null,
      loadedAt: performance.now(),
      maxIter: synthIter,
      maxFinite: Math.max(...kids.map((k) => k.maxFinite)),
      needsMore: kids.some((k) => k.needsMore),
      level,
      cost: 0.1,
      ranOut: Math.max(...kids.map((k) => k.ranOut)),
      synth: true,
      refGen: 0,
    });
    this.evictOverflow();
    this.dirty = true;
    return true;
  }

  // Re-request visible tiles that finalized with unresolved pixels below
  // the cap, one escalation rung at a time, center-out. Runs only from the
  // frame loop's idle check; the priority keeps these strictly behind any
  // real work that appears meanwhile.
  private planIdleRefine(): void {
    this.idleKeys.clear();
    const vis = this.camera.visibleTiles(this.cssW, this.cssH, this.dpr);
    const needsRef = vis.level >= PERTURB_MIN_LEVEL;
    const childLevel = vis.level + 1;
    const childOk = childLevel <= Math.ceil(MAX_ZOOM) + 2;
    const childNeedsRef = childLevel >= PERTURB_MIN_LEVEL;
    const childBase = this.baseIter(childLevel);
    for (const t of vis.tiles) {
      const key = this.tileKey(vis.level, t.tx, t.ty);
      const entry = this.cache.get(key);
      if (!entry || entry.tex.size - 2 * entry.tex.apron < TILE_SIZE) continue;
      const cx = t.x + vis.tilePx / 2 - this.cssW / 2;
      const cy = t.y + vis.tilePx / 2 - this.cssH / 2;
      const dist = cx * cx + cy * cy;
      // Pass 1: unresolved pixels below the ceiling — correctness first.
      if (
        !entry.needsMore && // the normal refresh path owns provisionals
        !entry.synth && // synthesized: the children hold the truth
        entry.ranOut > 0 &&
        entry.maxIter < refineCeil()
      ) {
        const next = Math.min(refineCeil(), entry.maxIter * ITER_ESCALATION);
        this.idleKeys.add(key);
        this.engine.requestTile({
          key,
          level: vis.level,
          tx: t.tx,
          ty: t.ty,
          size: TILE_SIZE,
          maxIter: next,
          // Past the interactive cap the worker keeps laddering up to this
          // ceiling (escaped references only — see the worker's guard).
          iterCap: Math.max(capBase(), next),
          needsRef,
          priority: IDLE_REFINE_PRIORITY + dist,
        });
        continue;
      }
      // Pass 2: children of settled tiles — they feed the supersampled
      // draw path (free antialiasing) and double as one level of zoom-in
      // prewarm. Strictly behind refinement in priority.
      if (!childOk || entry.needsMore) continue;
      for (let j = 0n; j <= 1n; j++) {
        for (let i = 0n; i <= 1n; i++) {
          const ctx = t.tx * 2n + i;
          const cty = t.ty * 2n + j;
          const childKey = this.tileKey(childLevel, ctx, cty);
          if (this.cache.has(childKey) || this.pendingTiles.has(childKey)) {
            continue;
          }
          this.idleKeys.add(childKey);
          this.engine.requestTile({
            key: childKey,
            level: childLevel,
            tx: ctx,
            ty: cty,
            size: TILE_SIZE,
            maxIter: this.tileIter(childLevel, ctx, cty, childBase),
            iterCap: capBase(),
            needsRef: childNeedsRef,
            priority: IDLE_REFINE_PRIORITY * 10 + dist,
          });
        }
      }
    }
  }

  // Per-tile budget: the level base, raised to the parent tile's measured
  // need when we have it — the child covers a subset of the parent's region,
  // so escape-time continuity makes the parent's max a reliable predictor.
  private tileIter(level: number, tx: bigint, ty: bigint, base: number): number {
    const parent = this.cache.get(this.tileKey(level - 1, tx >> 1n, ty >> 1n));
    if (!parent) return base;
    const inherited = Math.min(
      ITER_HARD_CAP,
      Math.ceil(parent.maxFinite * ITER_NEED_MARGIN) + ITER_NEED_PAD
    );
    return Math.max(base, inherited);
  }

  private onTile(
    key: string,
    data: Float32Array,
    iterDone: number,
    maxFinite: number,
    cost: number,
    final: boolean,
    refGen: number,
    ranOut: number
  ): void {
    // Export tiles commit immediately: their progress must not depend on
    // the rAF drain, which is capped per frame and paused in background
    // tabs entirely.
    if (this.exportActive && this.exportPinned.has(key)) {
      this.pendingTiles.delete(key);
      this.commitTile(key, data, iterDone, maxFinite, cost, final, refGen, ranOut);
      return;
    }
    this.pendingTiles.set(key, {
      data, iterDone, maxFinite, cost, final, refGen, ranOut,
    });
    this.dirty = true;
  }

  private commitTile(
    key: string,
    data: Float32Array,
    iterDone: number,
    maxFinite: number,
    cost: number,
    final: boolean,
    refGen: number,
    ranOut: number
  ): void {
    const existing = this.cache.get(key);
    // Worker tiles arrive with TILE_APRON texels of border data per side;
    // logical size drives all "is this full resolution" decisions.
    const phys = Math.round(Math.sqrt(data.length));
    const logical = phys - 2 * TILE_APRON;
    // Never replace better data with worse: a synthesis upgrade may have
    // landed while this job was running, and its child-inherited budget can
    // exceed anything the job computed. Waiters still fire (the entry they
    // find is the superior one), and a final full-size commit marks the
    // survivor done so the visible loop stops re-requesting it.
    if (
      existing &&
      existing.tex.size >= phys &&
      existing.maxIter >= iterDone
    ) {
      if (final && logical >= TILE_SIZE) {
        existing.needsMore = false;
        // The recompute confirmed this tile under the current generation;
        // stamp it so the re-level check doesn't loop on synthesis winners.
        existing.refGen = refGen;
      }
      const stale = this.tileWaiters.get(key);
      if (stale) {
        this.tileWaiters.delete(key);
        for (const w of stale) w();
      }
      this.dirty = true;
      return;
    }
    if (existing?.prevTex) this.renderer.deleteTile(existing.prevTex);
    const tex = this.renderer.uploadTile(data, phys, TILE_APRON);
    const level = levelOfKey(key);
    // Replacements keep the outgoing texture and fade the new one in over it
    // (see prevTex) — coarse-to-full upgrades and escalation frames blend.
    this.cache.set(key, {
      tex,
      prevTex: existing ? existing.tex : null,
      loadedAt: performance.now(),
      maxIter: iterDone,
      maxFinite,
      // More to come while the job is still escalating, or while the tile is
      // only the coarse first pass — either way a full-size request follows.
      needsMore: (!final && iterDone < ITER_HARD_CAP) || logical < TILE_SIZE,
      level,
      cost,
      ranOut,
      synth: false,
      refGen,
    });

    // Learn this level's iteration need from what the tile actually showed.
    // The measured max finite escape count (plus margin) is the bound above
    // which nothing more resolves — pixels still unresolved at the hard cap
    // are effectively interior and shouldn't inflate the level's floor.
    const need = Math.min(
      ITER_HARD_CAP,
      Math.ceil(maxFinite * ITER_NEED_MARGIN) + ITER_NEED_PAD
    );
    if (need > (this.iterFloor.get(level) ?? 0)) {
      this.iterFloor.set(level, need);
    }

    const waiters = this.tileWaiters.get(key);
    if (waiters) {
      this.tileWaiters.delete(key);
      for (const w of waiters) w();
    }

    this.evictOverflow();
    this.dirty = true;
  }

  private evictOverflow(): void {
    while (this.cache.size > TILE_CACHE_MAX) {
      // Eviction tiers, most expendable first:
      //  1. Tiles irrelevant to the current view — cheapest-to-recompute
      //     first, so a deep expensive corridor survives a trip to shallow
      //     water and back while distant cheap tiles go immediately.
      //  2. Relevant BREADTH (window prewarm, parents) — the central column
      //     and the visible level are spared until nothing else remains.
      //  3. LRU among non-base tiles, then absolute LRU.
      // During an export, pinned tiles AND everything the screen currently
      // wants are untouchable in every tier — evicting a visible tile
      // would blank part of the screen and burn a worker recomputing it.
      const untouchable = (k: string): boolean =>
        this.exportPinned.has(k) ||
        (this.exportActive && this.lastWanted.has(k));
      let evictKey: string | undefined;
      let evictCost = Infinity;
      for (const [k, e] of this.cache) {
        if (
          e.level <= BASE_PROTECT_LEVEL ||
          this.lastWanted.has(k) ||
          this.exportPinned.has(k)
        ) {
          continue;
        }
        if (e.cost < evictCost) {
          evictKey = k;
          evictCost = e.cost;
        }
      }
      if (evictKey === undefined) {
        for (const [k, e] of this.cache) {
          if (
            e.level <= BASE_PROTECT_LEVEL ||
            e.level === this.lastLevel ||
            this.centerKeys.has(k) ||
            untouchable(k)
          ) {
            continue;
          }
          if (e.cost < evictCost) {
            evictKey = k;
            evictCost = e.cost;
          }
        }
      }
      if (evictKey === undefined) {
        for (const [k, e] of this.cache) {
          if (e.level > BASE_PROTECT_LEVEL && !untouchable(k)) {
            evictKey = k;
            break;
          }
        }
      }
      if (evictKey === undefined) {
        for (const k of this.cache.keys()) {
          if (!untouchable(k)) {
            evictKey = k;
            break;
          }
        }
      }
      // Everything left is protected by an export in progress: let the
      // cache overshoot its cap for the session rather than tear frames
      // or the screen apart.
      if (evictKey === undefined) break;
      const evicted = this.cache.get(evictKey);
      if (evicted) {
        this.renderer.deleteTile(evicted.tex);
        if (evicted.prevTex) this.renderer.deleteTile(evicted.prevTex);
      }
      this.cache.delete(evictKey);
    }
    this.dirty = true;
  }

  // Settled-view supersampling: when a visible tile's four children are
  // cached and final (the dive prewarm computes them in dead time), draw
  // the children instead of the tile — the same field at twice the sample
  // density, i.e. free antialiasing from data that already exists. Only
  // for fully-faded tiles (fades blend the tile's own textures), and only
  // when the children's reference generation matches the tile's (mixed
  // generations visibly disagree in chaos-class regions; generation-free
  // children — direct path or synthesized — always agree).
  private drawSupersampled(
    entry: CacheEntry,
    level: number,
    tx: bigint,
    ty: bigint,
    xDev: number,
    yDev: number,
    sizeDev: number
  ): boolean {
    const kids: CacheEntry[] = [];
    for (let j = 0n; j <= 1n; j++) {
      for (let i = 0n; i <= 1n; i++) {
        const kid = this.cache.get(
          this.tileKey(level + 1, tx * 2n + i, ty * 2n + j)
        );
        // A synthesized parent IS its children's data — no generation
        // check can make them disagree with it.
        if (
          !kid ||
          kid.needsMore ||
          kid.tex.size - 2 * kid.tex.apron < TILE_SIZE ||
          (kid.refGen !== 0 && !entry.synth && kid.refGen !== entry.refGen)
        ) {
          return false;
        }
        kids.push(kid);
      }
    }
    // Diagnostic: tiles drawn supersampled this session (window.__fractileSS).
    (globalThis as { __fractileSS?: number }).__fractileSS =
      ((globalThis as { __fractileSS?: number }).__fractileSS ?? 0) + 1;
    const half = sizeDev / 2;
    for (let q = 0; q < 4; q++) {
      this.touch(this.tileKey(level + 1, tx * 2n + BigInt(q & 1), ty * 2n + BigInt(q >> 1)));
      this.renderer.drawTile(
        kids[q].tex,
        xDev + (q & 1) * half,
        yDev + (q >> 1) * half,
        half,
        half,
        0, 0, 1, 1, 1
      );
    }
    return true;
  }

  // Nearest cached ancestor at walk distance >= minDepth: nearby ancestors,
  // then a jump straight to the always-cached base grid — never hundreds of
  // lookups per missing tile per frame.
  private pickFallback(
    level: number,
    tx: bigint,
    ty: bigint,
    minDepth = 1
  ): { entry: CacheEntry; d: number } | null {
    const depths: number[] = [];
    const walk = Math.min(MAX_FALLBACK_WALK, level);
    for (let d = minDepth; d <= walk; d++) depths.push(d);
    const baseD = level - BASE_GRID_LEVEL;
    if (baseD > walk && baseD >= minDepth) depths.push(baseD);

    for (const d of depths) {
      const shift = BigInt(d);
      const entry = this.touch(
        this.tileKey(level - d, tx >> shift, ty >> shift)
      );
      if (entry) return { entry, d };
    }
    return null;
  }

  private drawFallbackPick(
    tx: bigint,
    ty: bigint,
    x: number,
    y: number,
    size: number,
    pick: { entry: CacheEntry; d: number }
  ): void {
    const shift = BigInt(pick.d);
    const ptx = tx >> shift;
    const pty = ty >> shift;
    const span = 2 ** -pick.d;
    // Sub-rect offsets via fixed-point: remainders can exceed float64's
    // integer range at large d, so treat them as d-bit fractions.
    const u0 = fixedToFloat(tx - (ptx << shift), pick.d);
    const v0 = fixedToFloat(ty - (pty << shift), pick.d);
    this.renderer.drawTile(
      pick.entry.tex,
      x,
      y,
      size,
      size,
      u0,
      v0,
      span,
      span,
      1
    );
  }

  private render(now: number): void {
    this.syncBackingStore();
    this.renderer.begin(this.canvas.width, this.canvas.height);

    const vis = this.camera.visibleTiles(this.cssW, this.cssH, this.dpr);
    this.lastLevel = vis.level;
    const maxIter = this.baseIter(vis.level);
    const needsRef = vis.level >= PERTURB_MIN_LEVEL;
    const activeGen = this.engine.activeRefGen();
    if (needsRef) {
      const ps = this.camera.pixelSizeParts();
      this.engine.ensureReference(
        this.camera.cxFP,
        this.camera.cyFP,
        this.camera.bits,
        maxIter,
        ps.m,
        ps.e
      );
    }

    const wanted = new Set<string>();
    const dpr = this.dpr;
    const sizeDev = vis.tilePx * dpr;
    let fading = false;

    for (const t of vis.tiles) {
      const key = this.tileKey(vis.level, t.tx, t.ty);
      wanted.add(key);
      let entry = this.touch(key);
      // Miss OR upgrade: children may carry refined data a starved cached
      // tile lacks (zooming out of a deep view) — trySynthesize self-gates.
      if (this.trySynthesize(vis.level, t.tx, t.ty)) {
        entry = this.touch(key);
      }
      const xDev = t.x * dpr;
      const yDev = t.y * dpr;
      const alpha = entry ? Math.min(1, (now - entry.loadedAt) / FADE_MS) : 0;
      if (entry?.prevTex && alpha >= 1) {
        this.renderer.deleteTile(entry.prevTex);
        entry.prevTex = null;
      }
      const cx = t.x + vis.tilePx / 2 - this.cssW / 2;
      const cy = t.y + vis.tilePx / 2 - this.cssH / 2;
      if (entry) {
        if (alpha < 1) {
          // Base layer of the fade: the tile's own previous texture, else
          // its nearest ancestor fallback.
          if (entry.prevTex) {
            this.renderer.drawTile(
              entry.prevTex, xDev, yDev, sizeDev, sizeDev, 0, 0, 1, 1, 1
            );
          } else {
            const pick = this.pickFallback(vis.level, t.tx, t.ty);
            if (pick) {
              this.drawFallbackPick(t.tx, t.ty, xDev, yDev, sizeDev, pick);
            }
          }
        }
        if (
          alpha < 1 ||
          !this.drawSupersampled(entry, vis.level, t.tx, t.ty, xDev, yDev, sizeDev)
        ) {
          this.renderer.drawTile(
            entry.tex, xDev, yDev, sizeDev, sizeDev, 0, 0, 1, 1, alpha
          );
        }
        if (alpha < 1) fading = true;
        // Re-level visible finals from a stale reference GENERATION: tiles
        // computed under different reference centers visibly disagree in
        // chaos-class regions (correlated rounding drift reads as broad
        // brightness shifts after the palette log-remap) — the mismatch the
        // user sees as seams between same-layer tiles after long pans or
        // rescues. Same-center extensions share a generation and are exempt,
        // so zoom-out corridors keep their cache hits.
        if (
          !entry.needsMore &&
          entry.refGen !== 0 &&
          activeGen !== 0 &&
          entry.refGen !== activeGen
        ) {
          entry.needsMore = true;
        }
        // A provisional frame whose escalation was cancelled off-screen:
        // finish it now that it's visible again (no-op while still running —
        // in-flight keys are deduplicated). Paused during export: these
        // ladders can hold a worker for many seconds each, and the export
        // owns the pool for the session.
        if (entry.needsMore && !this.exportActive && !this.pendingTiles.has(key)) {
          this.engine.requestTile({
            key,
            level: vis.level,
            tx: t.tx,
            ty: t.ty,
            size: TILE_SIZE,
            maxIter: Math.min(
              capBase(),
              Math.max(this.baseIter(vis.level), entry.maxIter)
            ),
            iterCap: capBase(),
            needsRef,
            priority: cx * cx + cy * cy,
          });
        }
      } else {
        const pick = this.pickFallback(vis.level, t.tx, t.ty);
        if (pick) {
          this.drawFallbackPick(t.tx, t.ty, xDev, yDev, sizeDev, pick);
        }
        if (!this.pendingTiles.has(key)) {
          // Nothing at this tile yet: with only a distant ancestor to show
          // (deep-stretched mush), ask for the coarse first pass; with a
          // near ancestor (routine one-level zooms) go straight to full.
          this.engine.requestTile({
            key,
            level: vis.level,
            tx: t.tx,
            ty: t.ty,
            size: (pick?.d ?? Infinity) > 2 ? COARSE_TILE_SIZE : TILE_SIZE,
            maxIter: this.tileIter(vis.level, t.tx, t.ty, maxIter),
            iterCap: capBase(),
            needsRef,
            priority: cx * cx + cy * cy,
          });
        }
      }
    }

    // Preload the parent level so zooming out (and fallback rendering) is
    // instant; deeper ancestors chain lazily as those tiles render.
    if (vis.level > 0) {
      const parentLevel = vis.level - 1;
      const parentIter = this.baseIter(parentLevel);
      const parentNeedsRef = parentLevel >= PERTURB_MIN_LEVEL;
      const parents = new Set<string>();
      for (const t of vis.tiles) {
        const ptx = t.tx >> 1n;
        const pty = t.ty >> 1n;
        const key = this.tileKey(parentLevel, ptx, pty);
        if (parents.has(key)) continue;
        parents.add(key);
        wanted.add(key);
        this.trySynthesize(parentLevel, ptx, pty);
        if (!this.cache.has(key)) {
          this.engine.requestTile({
            key,
            level: parentLevel,
            tx: ptx,
            ty: pty,
            size: TILE_SIZE,
            maxIter: this.tileIter(parentLevel, ptx, pty, parentIter),
            iterCap: capBase(),
            needsRef: parentNeedsRef,
            priority: PRELOAD_PRIORITY,
          });
        }
      }
    }

    // Keep the whole base-level world grid computed and cached — the deepest
    // fallback, so the background never shows through.
    const baseGridIter = this.baseIter(BASE_GRID_LEVEL);
    for (const base of this.baseGridTiles) {
      wanted.add(base.key);
      if (!this.cache.has(base.key) && !this.pendingTiles.has(base.key)) {
        this.engine.requestTile({
          key: base.key,
          level: BASE_GRID_LEVEL,
          tx: base.tx,
          ty: base.ty,
          size: TILE_SIZE,
          maxIter: baseGridIter,
          needsRef: false,
          priority: BASE_GRID_PRIORITY,
        });
      }
    }

    // Touch the view center's nearby ancestor chain so LRU pressure never
    // evicts the tiles a zoom-out will land on (deeper ancestors are covered
    // by the always-protected base grid).
    if (vis.tiles.length > 0) {
      const mid = vis.tiles[vis.tiles.length >> 1];
      let atx = mid.tx;
      let aty = mid.ty;
      const floor = Math.max(0, vis.level - MAX_ANCESTOR_TOUCH);
      for (let lvl = vis.level - 1; lvl >= floor; lvl--) {
        atx >>= 1n;
        aty >>= 1n;
        this.touch(this.tileKey(lvl, atx, aty));
      }
    }

    // Keep the planned zoom-out corridor alive across renders: retain() must
    // not cancel its queued jobs, and eviction must not eat its tiles. Same
    // for an in-progress export's window and the idle planner's work.
    for (const key of this.prewarmKeys) wanted.add(key);
    for (const key of this.exportPinned) wanted.add(key);
    for (const key of this.idleKeys) wanted.add(key);

    this.engine.retain(wanted);
    this.lastWanted = wanted;
    if (fading) this.dirty = true;
  }

  // --- input ---

  private canvasPoint(e: PointerEvent | WheelEvent | MouseEvent): {
    x: number;
    y: number;
  } {
    // getBoundingClientRect forces layout; cache it (invalidated on resize).
    if (!this.canvasRect) {
      this.canvasRect = this.canvas.getBoundingClientRect();
    }
    return {
      x: e.clientX - this.canvasRect.left,
      y: e.clientY - this.canvasRect.top,
    };
  }

  private offsetFromCenter(p: { x: number; y: number }): {
    x: number;
    y: number;
  } {
    return { x: p.x - this.cssW / 2, y: p.y - this.cssH / 2 };
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.canvasPoint(e);
    this.pointers.set(e.pointerId, p);
    this.inertia = null;
    this.targetZoom = this.camera.zoom;

    // Double click/tap zoom, detected manually from pointer events (the
    // native dblclick event is unreliable across browsers and inputs).
    if (
      this.pointers.size === 1 &&
      this.lastTap &&
      performance.now() - this.lastTap.t < DOUBLE_TAP_MS &&
      Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < DOUBLE_TAP_PX
    ) {
      this.lastTap = null;
      this.pointers.delete(e.pointerId);
      this.zoomBy(1, p);
      return;
    }

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.camera.zoom };
      this.lastDrag = null;
    } else if (e.shiftKey && e.pointerType === "mouse") {
      this.boxStart = p;
      this.boxEl = document.createElement("div");
      Object.assign(this.boxEl.style, {
        position: "absolute",
        border: "1px dashed rgba(255, 255, 255, 0.9)",
        background: "rgba(255, 255, 255, 0.08)",
        pointerEvents: "none",
        zIndex: "10",
      });
      this.container.appendChild(this.boxEl);
    } else {
      this.lastDrag = { x: p.x, y: p.y, dist: 0 };
      this.dragSamples = [{ t: performance.now(), x: p.x, y: p.y }];
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.canvasPoint(e);
    this.pointers.set(e.pointerId, p);

    if (this.boxStart && this.boxEl) {
      const x = Math.min(this.boxStart.x, p.x);
      const y = Math.min(this.boxStart.y, p.y);
      Object.assign(this.boxEl.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${Math.abs(p.x - this.boxStart.x)}px`,
        height: `${Math.abs(p.y - this.boxStart.y)}px`,
      });
      return;
    }

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0 && this.pinch.dist > 0) {
        const mid = this.offsetFromCenter({
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
        });
        const zoom = this.pinch.zoom + Math.log2(dist / this.pinch.dist);
        this.camera.zoomTo(zoom, mid.x, mid.y);
        this.targetZoom = this.camera.zoom;
        this.onCameraMove();
      }
      return;
    }

    if (this.lastDrag && this.pointers.size === 1) {
      const now = performance.now();
      const dx = p.x - this.lastDrag.x;
      const dy = p.y - this.lastDrag.y;
      this.pendingPanX -= dx;
      this.pendingPanY -= dy;
      this.lastDrag = {
        x: p.x,
        y: p.y,
        dist: this.lastDrag.dist + Math.hypot(dx, dy),
      };
      this.dragSamples.push({ t: now, x: p.x, y: p.y });
      while (
        this.dragSamples.length > 1 &&
        now - this.dragSamples[0].t > VELOCITY_WINDOW_MS
      ) {
        this.dragSamples.shift();
      }
      this.onCameraMove();
    }
  };

  // Release velocity from the recent-sample window; zero if the pointer had
  // already stopped (stale samples) so a paused drag never coasts.
  private releaseVelocity(): { vx: number; vy: number } {
    const now = performance.now();
    const samples = this.dragSamples;
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const last = samples[samples.length - 1];
    if (now - last.t > INERTIA_STALE_MS) return { vx: 0, vy: 0 };
    const first =
      samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ??
      samples[0];
    const dt = last.t - first.t;
    if (dt < 1) return { vx: 0, vy: 0 };
    return { vx: -(last.x - first.x) / dt, vy: -(last.y - first.y) / dt };
  }

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);

    if (this.boxStart && this.boxEl) {
      const p = this.canvasPoint(e);
      const w = Math.abs(p.x - this.boxStart.x);
      const h = Math.abs(p.y - this.boxStart.y);
      this.boxEl.remove();
      this.boxEl = null;
      const start = this.boxStart;
      this.boxStart = null;
      if (w > 8 && h > 8) {
        const mid = this.offsetFromCenter({
          x: (start.x + p.x) / 2,
          y: (start.y + p.y) / 2,
        });
        const zoom1 = Math.min(
          MAX_ZOOM,
          this.camera.zoom + Math.log2(Math.min(this.cssW / w, this.cssH / h))
        );
        // The whole transition is one similarity transform: zooming about
        // its unique fixed screen point moves the box center to the middle
        // and magnifies in a single inseparable motion. K/(K-1) puts that
        // point just beyond the box's far side.
        const K = 2 ** (zoom1 - this.camera.zoom);
        if (K > 1.001) {
          const f = K / (K - 1);
          this.zoomAnchor = { x: mid.x * f, y: mid.y * f };
          this.targetZoom = zoom1;
          this.dirty = true;
        }
      }
      return;
    }

    if (this.pointers.size < 2) this.pinch = null;

    if (this.pointers.size === 0 && this.lastDrag) {
      const { vx, vy } = this.releaseVelocity();
      if (Math.hypot(vx, vy) > 0.05) {
        this.inertia = { vx, vy };
      }
      // A press that barely moved is a tap — remember it for double-tap zoom.
      this.lastTap =
        this.lastDrag.dist < 6
          ? { x: this.lastDrag.x, y: this.lastDrag.y, t: performance.now() }
          : null;
      this.lastDrag = null;
      this.dragSamples = [];
    }
  };

  private zoomBy(delta: number, at: { x: number; y: number }): void {
    this.targetZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, this.targetZoom + delta)
    );
    this.zoomAnchor = this.offsetFromCenter(at);
    this.dirty = true;
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 20 : 1; // line-mode wheels
    const delta = Math.max(
      -2,
      Math.min(2, (-e.deltaY * scale * WHEEL_ZOOM_PER_100) / 100)
    );
    this.zoomBy(delta, this.canvasPoint(e));
  };
}
