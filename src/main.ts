import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";

const SIZE = 256;
const BASE_ITERATIONS = 1024;

const locationFromHash = (hash: string): [number, [number, number]] => {
  const trim_hash = hash.replace("#map=", "");
  const parts = trim_hash.split("/");
  if (parts.length === 3) {
    const zoom = parseFloat(parts[0]);
    const center: [number, number] = [
      parseFloat(parts[1]),
      parseFloat(parts[2]),
    ];
    return [zoom, center];
  } else {
    throw new Error("invalid location hash");
  }
};

let zoom = 2.5;
let center: [number, number] = [-5000000, 0];

if (window.location.hash) {
  try {
    [zoom, center] = locationFromHash(window.location.hash);
  } catch {}
}

const loadTile = (z: number, x: number, y: number): Promise<Uint8Array> => {
  return new Promise((resolve, reject) => {
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
      size: SIZE,
      iterations: BASE_ITERATIONS + BASE_ITERATIONS * z,
    });
  });
};

const map = new Map({
  pixelRatio: window.devicePixelRatio,
  maxTilesLoading: navigator.hardwareConcurrency,
  target: "map",
  controls: [],
  layers: [
    new TileLayer({
      extent: [-80000000, -40000000, 60000000, 40000000],
      preload: Infinity,
      source: new DataTile({
        interpolate: true,
        transition: 0,
        tileSize: SIZE,
        loader: loadTile,
      }),
    }),
  ],
  view: new View({
    multiWorld: true,
    extent: [-80000000, -40000000, 60000000, 40000000],
    minZoom: 2,
    maxZoom: 42,
    enableRotation: false,
    center,
    zoom,
  }),
});

let shouldUpdate = true;
const view = map.getView();
const updatePermalink = () => {
  if (!shouldUpdate) {
    shouldUpdate = true;
    return;
  }
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
