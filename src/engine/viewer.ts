// The tile map viewer: render loop, LRU tile cache with parent-tile fallback
// and fade-in, tile scheduling, and pointer/wheel/pinch input. Replaces
// OpenLayers with the same interaction feel, minus the float64 ceiling.

import {
  BASE_ITERATIONS,
  DeepCamera,
  ITER_HARD_CAP,
  MAX_ZOOM,
  MIN_ZOOM,
  PERTURB_MIN_LEVEL,
  TILE_SIZE,
} from "./camera";
import { FractalEngine } from "./pool";
import { parseHash, serializeHash } from "./permalink";
import { StyleVars, TileHandle, TileRenderer } from "./renderer";
import { fixedToFloat } from "./fixedPoint";

const TILE_CACHE_MAX = 768;
const FADE_MS = 120;
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

type CacheEntry = {
  tex: TileHandle;
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
    }
  >();
  private canvasRect: DOMRect | null = null;
  private pinch: { dist: number; zoom: number } | null = null;
  private lastTap: { x: number; y: number; t: number } | null = null;
  private boxStart: { x: number; y: number } | null = null;
  private boxEl: HTMLDivElement | null = null;

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private resizeObserver: ResizeObserver;

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
      (key, data, iterDone, maxFinite, cost, final) =>
        this.onTile(key, data, iterDone, maxFinite, cost, final)
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

  // --- internals ---

  private onCameraMove(): void {
    this.moved = true;
    this.lastMoveAt = performance.now();
    this.dirty = true;
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
          tile.final
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

  // Plan the zoom-out corridor: viewport-sized tile windows centered on the
  // current view center at each ancestor level, nearest level first, until
  // the tile budget is spent. Requested at prewarm priority, so workers only
  // pick them up when nothing interactive is queued; render() keeps the keys
  // in the wanted set, and the next moveend replans (which also cancels any
  // no-longer-relevant queued prewarm work via retain).
  private planPrewarm(): void {
    this.prewarmKeys.clear();
    const vis = this.camera.visibleTiles(this.cssW, this.cssH, this.dpr);
    const halfX = Math.ceil(((this.cssW * this.dpr) / TILE_SIZE + 1) / 2);
    const halfY = Math.ceil(((this.cssH * this.dpr) / TILE_SIZE + 1) / 2);
    const eight = 8n << BigInt(this.camera.bits);
    let budget = PREWARM_TILE_BUDGET;
    for (let d = 2; budget > 0; d++) {
      const level = vis.level - d;
      if (level <= BASE_GRID_LEVEL) break;
      const shift = BigInt(this.camera.bits + 4 - level);
      const ctx = (this.camera.cxFP + eight) >> shift;
      const cty = (this.camera.cyFP + eight) >> shift;
      const maxTile = (1n << BigInt(level)) - 1n;
      const base = this.baseIter(level);
      const needsRef = level >= PERTURB_MIN_LEVEL;
      for (let dy = -halfY; dy <= halfY && budget > 0; dy++) {
        for (let dx = -halfX; dx <= halfX && budget > 0; dx++) {
          const tx = ctx + BigInt(dx);
          const ty = cty + BigInt(dy);
          if (tx < 0n || ty < 0n || tx > maxTile || ty > maxTile) continue;
          const key = this.tileKey(level, tx, ty);
          this.prewarmKeys.add(key);
          budget--;
          if (this.cache.has(key) || this.pendingTiles.has(key)) continue;
          this.engine.requestTile({
            key,
            level,
            tx,
            ty,
            size: TILE_SIZE,
            maxIter: this.tileIter(level, tx, ty, base),
            needsRef,
            priority: PREWARM_PRIORITY + d * 1e9 + (dx * dx + dy * dy),
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
    final: boolean
  ): void {
    this.pendingTiles.set(key, { data, iterDone, maxFinite, cost, final });
    this.dirty = true;
  }

  private commitTile(
    key: string,
    data: Float32Array,
    iterDone: number,
    maxFinite: number,
    cost: number,
    final: boolean
  ): void {
    const existing = this.cache.get(key);
    if (existing) this.renderer.deleteTile(existing.tex);
    const tex = this.renderer.uploadTile(data, TILE_SIZE);
    const level = levelOfKey(key);
    // Provisional escalation frames swap the texture in place, no re-fade.
    this.cache.set(key, {
      tex,
      loadedAt: existing ? existing.loadedAt : performance.now(),
      maxIter: iterDone,
      maxFinite,
      needsMore: !final && iterDone < ITER_HARD_CAP,
      level,
      cost,
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

    while (this.cache.size > TILE_CACHE_MAX) {
      // Eviction order: among tiles that are neither base-level nor relevant
      // to the current view, sacrifice the cheapest-to-recompute first (ties
      // to the least recently used) — a deep, expensive corridor survives a
      // trip to shallow water and back, while distant cheap tiles go
      // immediately. Fallbacks: LRU non-base, then absolute LRU.
      let evictKey: string | undefined;
      let evictCost = Infinity;
      for (const [k, e] of this.cache) {
        if (e.level <= BASE_PROTECT_LEVEL || this.lastWanted.has(k)) continue;
        if (e.cost < evictCost) {
          evictKey = k;
          evictCost = e.cost;
        }
      }
      if (evictKey === undefined) {
        for (const [k, e] of this.cache) {
          if (e.level > BASE_PROTECT_LEVEL) {
            evictKey = k;
            break;
          }
        }
      }
      if (evictKey === undefined) {
        evictKey = this.cache.keys().next().value as string;
      }
      const evicted = this.cache.get(evictKey);
      if (evicted) this.renderer.deleteTile(evicted.tex);
      this.cache.delete(evictKey);
    }
    this.dirty = true;
  }

  private drawFallback(
    level: number,
    tx: bigint,
    ty: bigint,
    x: number,
    y: number,
    size: number
  ): void {
    // Try nearby ancestors, then jump straight to the always-cached base
    // grid — never hundreds of lookups per missing tile per frame.
    const depths: number[] = [];
    const walk = Math.min(MAX_FALLBACK_WALK, level);
    for (let d = 1; d <= walk; d++) depths.push(d);
    if (level - BASE_GRID_LEVEL > walk) depths.push(level - BASE_GRID_LEVEL);

    for (const d of depths) {
      const shift = BigInt(d);
      const ptx = tx >> shift;
      const pty = ty >> shift;
      const entry = this.touch(this.tileKey(level - d, ptx, pty));
      if (!entry) continue;
      const span = 2 ** -d;
      // Sub-rect offsets via fixed-point: remainders can exceed float64's
      // integer range at large d, so treat them as d-bit fractions.
      const u0 = fixedToFloat(tx - (ptx << shift), d);
      const v0 = fixedToFloat(ty - (pty << shift), d);
      this.renderer.drawTile(entry.tex, x, y, size, size, u0, v0, span, span, 1);
      return;
    }
  }

  private render(now: number): void {
    this.syncBackingStore();
    this.renderer.begin(this.canvas.width, this.canvas.height);

    const vis = this.camera.visibleTiles(this.cssW, this.cssH, this.dpr);
    const maxIter = this.baseIter(vis.level);
    const needsRef = vis.level >= PERTURB_MIN_LEVEL;
    if (needsRef) {
      this.engine.ensureReference(
        this.camera.cxFP,
        this.camera.cyFP,
        this.camera.bits,
        maxIter,
        this.camera.pixelSize()
      );
    }

    const wanted = new Set<string>();
    const dpr = this.dpr;
    const sizeDev = vis.tilePx * dpr;
    let fading = false;

    for (const t of vis.tiles) {
      const key = this.tileKey(vis.level, t.tx, t.ty);
      wanted.add(key);
      const entry = this.touch(key);
      const xDev = t.x * dpr;
      const yDev = t.y * dpr;
      const alpha = entry ? Math.min(1, (now - entry.loadedAt) / FADE_MS) : 0;
      if (alpha < 1) {
        this.drawFallback(vis.level, t.tx, t.ty, xDev, yDev, sizeDev);
      }
      const cx = t.x + vis.tilePx / 2 - this.cssW / 2;
      const cy = t.y + vis.tilePx / 2 - this.cssH / 2;
      if (entry) {
        this.renderer.drawTile(
          entry.tex,
          xDev,
          yDev,
          sizeDev,
          sizeDev,
          0,
          0,
          1,
          1,
          alpha
        );
        if (alpha < 1) fading = true;
        // A provisional frame whose escalation was cancelled off-screen:
        // finish it now that it's visible again (no-op while still running —
        // in-flight keys are deduplicated).
        if (entry.needsMore && !this.pendingTiles.has(key)) {
          this.engine.requestTile({
            key,
            level: vis.level,
            tx: t.tx,
            ty: t.ty,
            size: TILE_SIZE,
            maxIter: Math.min(
              ITER_HARD_CAP,
              Math.max(this.baseIter(vis.level), entry.maxIter)
            ),
            needsRef,
            priority: cx * cx + cy * cy,
          });
        }
      } else if (!this.pendingTiles.has(key)) {
        this.engine.requestTile({
          key,
          level: vis.level,
          tx: t.tx,
          ty: t.ty,
          size: TILE_SIZE,
          maxIter: this.tileIter(vis.level, t.tx, t.ty, maxIter),
          needsRef,
          priority: cx * cx + cy * cy,
        });
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
        if (!this.cache.has(key)) {
          this.engine.requestTile({
            key,
            level: parentLevel,
            tx: ptx,
            ty: pty,
            size: TILE_SIZE,
            maxIter: this.tileIter(parentLevel, ptx, pty, parentIter),
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
    // not cancel its queued jobs, and eviction must not eat its tiles.
    for (const key of this.prewarmKeys) wanted.add(key);

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
