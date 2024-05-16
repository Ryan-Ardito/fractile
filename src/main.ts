import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";
import { Extent } from "ol/extent";

type MapCoords = [number, number];
type ZoomCoords = [number, MapCoords];

const TILE_SIZE = 256;
const BASE_ITERATIONS = 1024;

const locationFromHash = (hash: string): ZoomCoords => {
  const trim_hash = hash.replace("#map=", "");
  const parts = trim_hash.split("/");
  if (parts.length === 3) {
    const zoom = parseFloat(parts[0]);
    const center: MapCoords = [parseFloat(parts[1]), parseFloat(parts[2])];
    return [zoom, center];
  } else {
    throw new Error("invalid location hash");
  }
};

let zoom = 3;
let center: MapCoords = [-2500000, 0];

if (window.location.hash) {
  try {
    [zoom, center] = locationFromHash(window.location.hash);
  } catch {}
}

const loadTile = (z: number, x: number, y: number): Promise<Uint8Array> => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./mandelbrotWorker.ts", import.meta.url),
      { type: "module" }
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

const extent: Extent = [-80000000, -40000000, 60000000, 40000000];

const view = new View({
  multiWorld: true,
  extent,
  minZoom: 2,
  maxZoom: 42,
  enableRotation: false,
  center,
  zoom,
});

const layer = new TileLayer({
  style: {
    color: ["array", ["band", 1], ["band", 2], ["band", 3], ["band", 4]],
  },
  extent,
  preload: Infinity,
  source: new DataTile({
    interpolate: true,
    transition: 0,
    tileSize: TILE_SIZE,
    loader: loadTile,
  }),
});

const map = new Map({
  pixelRatio: window.devicePixelRatio,
  maxTilesLoading: navigator.hardwareConcurrency,
  target: "map",
  controls: [],
  layers: [layer],
  view,
});

let shouldUpdate = true;
const mapView = map.getView();

const updatePermalink = () => {
  if (!shouldUpdate) {
    shouldUpdate = true;
    return;
  }

  const center = mapView.getCenter();
  const zoom = mapView.getZoom();
  if (!center || !mapView || !zoom) {
    return;
  }

  const hash = `#map=${zoom.toString()}/${center[0].toString()}/${center[1].toString()}`;
  const state = {
    zoom: mapView.getZoom(),
    center: mapView.getCenter(),
  };

  window.history.replaceState(state, "map", hash);
};

map.on("moveend", updatePermalink);

window.addEventListener("hashchange", (ev) => {
  try {
    const url = ev.newURL;
    const hash = url.substring(url.indexOf("#"));
    const [zoom, center] = locationFromHash(hash);
    map.getView().setCenter(center);
    map.getView().setZoom(zoom);
  } catch {}
});

window.addEventListener("popstate", (event) => {
  if (event.state === null) {
    return;
  }
  map.getView().setCenter(event.state.center);
  map.getView().setZoom(event.state.zoom);
  shouldUpdate = false;
});

const wakeTime = 1000;
let timeout: number;

const hideMouseCursor = () => {
  if (document.body.style.cursor !== "none") {
    document.body.style.cursor = "none";
  }
};

const showMouseCursor = () => {
  clearTimeout(timeout);
  if (document.body.style.cursor !== "default") {
    document.body.style.cursor = "default";
  }
};

document.onmousemove = () => {
  showMouseCursor();
  timeout = setTimeout(hideMouseCursor, wakeTime);
};

document.onmousedown = () => {
  showMouseCursor();
  timeout = setTimeout(hideMouseCursor, wakeTime);
};
