import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";

const size = 512;
const BASE_ITERATIONS = 512;

let zoom = 2.5;
let center = [-5000000, 0];

if (window.location.hash !== "") {
  const hash = window.location.hash.replace("#map=", "");
  const parts = hash.split("/");
  if (parts.length === 3) {
    console.log(parts);
    zoom = parseFloat(parts[0]);
    center = [parseFloat(parts[1]), parseFloat(parts[2])];
  }
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
      size,
      iterations: BASE_ITERATIONS + BASE_ITERATIONS * z,
    });
  });
};

const map = new Map({
  maxTilesLoading: 8,
  target: "map",
  controls: [],
  layers: [
    new TileLayer({
      extent: [-80000000, -40000000, 60000000, 40000000],
      preload: Infinity,
      source: new DataTile({
        interpolate: true,
        transition: 0,
        tileSize: size,
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
    // do not update the URL when the view was changed in the 'popstate' handler
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

// restore the view state when navigating through the history, see
// https://developer.mozilla.org/en-US/docs/Web/API/WindowEventHandlers/onpopstate
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
let currentCursor = document.body.style.cursor;
currentCursor == "none" ? "default" : currentCursor;

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
