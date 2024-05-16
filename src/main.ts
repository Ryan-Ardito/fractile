import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";
import { Extent } from "ol/extent";
import { colorPixel } from "./color";
import { ExpressionValue } from "ol/style/webgl";

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

let zoom = 2;
let center: MapCoords = [-5000000, 0];

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

function unpackUint32(data: number[]): number {
  const byte1 = data[0] << 24;
  const byte2 = data[1] << 16;
  const byte3 = data[2] << 8;
  const byte4 = data[3];

  return byte1 | byte2 | byte3 | byte4;
}

const extent: Extent = [-80000000, -40000000, 60000000, 40000000];

const view = new View({
  multiWorld: true,
  extent,
  minZoom: 1,
  maxZoom: 42,
  enableRotation: false,
  center,
  zoom,
});

const colorPixelExpression = (): ExpressionValue => {
  const normalizedIters = [
    "floor",
    ["+", ["*", ["band", 1], ["^", 2, 24]],
    ["+", ["*", ["band", 2], ["^", 2, 16]],
    ["+", ["*", ["band", 3], ["^", 2, 8]],
    ["band", 4]]]]
  ];
  const value = ["*", normalizedIters, 255];
  // const red = ["/", ["*", ["%", value, 8], 32], 255];
  // const green = ["/", ["*", ["%", value, 16], 16], 255];
  // const blue = ["/", ["*", ["%", value, 32], 8], 255];
  const red = ["*", ["%", value, 8], 32];
  const green = ["*", ["%", value, 16], 16];
  const blue = ["*", ["%", value, 32], 8];
  return ["color", red, green, blue, 1];
  // return ["array", ["band", 1], ["band", 2], ["band", 3], ["band", 4]];
};

// const PALETTE_SCALE = 64;
// const PALETTE_OFFSET = 0;
// const colorPixelExpression = () => {
//   // unpack Uint32 from Uint8Array bands
//   const normalizedIters = [
//     "floor",
//     ["+", ["*", ["band", 1], ["^", 2, 24]]],
//     ["+", ["*", ["band", 2], ["^", 2, 16]]],
//     ["+", ["*", ["band", 3], ["^", 2, 8]]],
//     ["+", ["band", 4]],
//   ];

//   const colorAdjust = [
//     "+",
//     ["*", PALETTE_SCALE, normalizedIters],
//     PALETTE_OFFSET,
//   ];
//   const hue = ["%", [["*", normalizedIters], 360], []];
//   const variance = ["+", 0.42, ["sin", ["*", 0.1]]];
//   const blackPixel = ["array", 0, 0, 0, 1];

//   return ["array", ["band", 1], ["band", 2], ["band", 3], ["band", 4]];
// };

const layer = new TileLayer({
  style: {
    color: colorPixelExpression(),
  },
  extent,
  preload: Infinity,
  source: new DataTile({
    // interpolate: true,
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
