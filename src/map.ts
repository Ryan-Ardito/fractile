import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";
import { Extent } from "ol/extent";
import { colorPixelExpression } from "./colorGL";
import { Coordinate } from "ol/coordinate";
import { locationFromHash } from "./listeners";

const TILE_SIZE = 256;
const BASE_ITERATIONS = 1024;

let zoom = 4;
let center: Coordinate = [-1200000, 0];

if (window.location.hash) {
  try {
    [zoom, center] = locationFromHash(window.location.hash);
  } catch {}
}

const loadTile = (z: number, x: number, y: number): Promise<Uint8Array> => {
  return new Promise((resolve, reject) => {
    // hacky black real line fix
    z += 1e-9;

    const worker = new Worker(
      new URL("./mandelbrotWorker.ts", import.meta.url)
    );

    worker.onmessage = (e) => {
      const data = e.data;
      worker.terminate();
      resolve(data);
    };

    worker.onerror = (error) => {
      worker.terminate();
      reject(error);
    };

    worker.postMessage({
      z,
      x,
      y,
      size: TILE_SIZE,
      iterations: BASE_ITERATIONS * z,
    });
  });
};

const extent: Extent = [-30000000, -15000000, 30000000, 15000000];

export const view = new View({
  multiWorld: true,
  extent,
  minZoom: 3,
  maxZoom: 42,
  enableRotation: false,
  center,
  zoom,
});

export const layer = new TileLayer({
  style: {
    color: colorPixelExpression(),
    variables: {
      iterFalloff: 24,
      paletteScale: 1,
      hueOffset: 0,
      bandSpacing: 8,
      bandContrast: 0.28,
      bandOffset: 0,
      saturation: 0.8,
      lightness: 1,
    },
  },
  extent,
  preload: Infinity,
  source: new DataTile({
    // interpolate: true,
    bandCount: 1,
    transition: 0,
    tileSize: TILE_SIZE,
    loader: loadTile,
  }),
});

export const map = new Map({
  pixelRatio: window.devicePixelRatio,
  maxTilesLoading: navigator.hardwareConcurrency,
  target: "map",
  controls: [],
  layers: [layer],
  view,
});
