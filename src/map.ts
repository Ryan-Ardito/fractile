import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";
import { Extent } from "ol/extent";
import { colorPixelExpression } from "./colorGL";
import { Coordinate } from "ol/coordinate";

const TILE_SIZE = 256;
const BASE_ITERATIONS = 1024;

type ZoomCoords = [number, Coordinate];

let zoom = 4;
let center: Coordinate = [-1200000, 0];

export const locationFromHash = (hash: string): ZoomCoords => {
  const trim_hash = hash.replace("#map=", "");
  const parts = trim_hash.split("/");
  if (parts.length === 3) {
    const zoom = parseFloat(parts[0]);
    const center: Coordinate = [parseFloat(parts[1]), parseFloat(parts[2])];
    return [zoom, center];
  } else {
    throw new Error("invalid location hash");
  }
};

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

let shouldUpdate = true;

const updatePermalink = () => {
  if (!shouldUpdate) {
    shouldUpdate = true;
    return;
  }

  map.on("moveend", updatePermalink);

  window.addEventListener("hashchange", (ev) => {
    try {
      const url = ev.newURL;
      const hash = url.substring(url.indexOf("#"));
      const [zoom, center] = locationFromHash(hash);
      map.getView().setZoom(zoom);
      map.getView().setCenter(center);
      const state = {
        zoom: view.getZoom(),
        center: view.getCenter(),
      };

      window.history.replaceState(state, "map", hash);
    } catch {}
  });

  window.onpopstate = (event) => {
    if (event.state === null) {
      return;
    }
    map.getView().setCenter(event.state.center);
    map.getView().setZoom(event.state.zoom);
    shouldUpdate = false;
  };

  const center = view.getCenter();
  const zoom = view.getZoom();
  if (!center || !view || !zoom) {
    return;
  }

  const hash = `#map=${zoom.toString()}/${center[0].toString()}/${center[1].toString()}`;
  const state = {
    zoom: view.getZoom(),
    center: view.getCenter(),
  };

  window.history.replaceState(state, "map", hash);
};
