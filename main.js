import DataTile from "ol/source/DataTile.js";
import Map from "ol/Map.js";
import TileLayer from "ol/layer/WebGLTile.js";
import View from "ol/View.js";

const size = 256;

const loadTile = (z, x, y) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker("mandelbrotWorker.js");
    worker.onmessage = (e) => {
      const data = e.data;
      worker.terminate();
      resolve(data);
    };

    worker.onerror = (error) => {
      worker.terminate();
      reject(error);
    };

    worker.postMessage({ z, x, y, size });
  });
};

const map = new Map({
  target: "map",
  layers: [
    new TileLayer({
      preload: Infinity,
      source: new DataTile({
        loader: loadTile,
      }),
    }),
  ],
  view: new View({
    center: [0, 0],
    zoom: 0,
  }),
});
