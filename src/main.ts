import DataTile, { Loader } from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";
// import { FullScreen, defaults as defaultControls } from "ol/control.js";

const size = 512;
const iterations = 2 ** 12;

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

    worker.postMessage({ z, x, y, size, iterations });
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
        // interpolate: true,
        transition: 0,
        tileSize: size,
        loader: loadTile as Loader,
      }),
    }),
  ],
  view: new View({
    constrainResolution: true,
    maxZoom: 42,
    enableRotation: false,
    center: [0, 0],
    zoom: 0,
  }),
});
