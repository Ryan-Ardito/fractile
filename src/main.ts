import DataTile, { Loader } from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";
// import { FullScreen, defaults as defaultControls } from "ol/control.js";

const size = 512;
const BASE_ITERATIONS = 256;

let zoom = 2;
let center = [0, 0];

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

// let span = document.createElement("span");
// span.innerHTML = "&#x26F6;";

const map = new Map({
  target: "map",
  controls: [],
  // controls: [
  //   new FullScreen({
  //     label: span,
  //   }),
  // ],
  layers: [
    new TileLayer({
      preload: Infinity,
      source: new DataTile({
        interpolate: true,
        transition: 0,
        tileSize: size,
        loader: loadTile as Loader,
      }),
    }),
  ],
  view: new View({
    minZoom: 0,
    maxZoom: 42,
    enableRotation: false,
    center,
    zoom,
  }),
});

let shouldUpdate = true;
const view = map.getView();
const updatePermalink = function () {
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
window.addEventListener("popstate", function (event) {
  if (event.state === null) {
    return;
  }
  map.getView().setCenter(event.state.center);
  map.getView().setZoom(event.state.zoom);
  shouldUpdate = false;
});
