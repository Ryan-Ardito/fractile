import DataTile from "ol/source/DataTile.js";
import Map from "ol/Map.js";
import TileLayer from "ol/layer/WebGLTile.js";
import View from "ol/View.js";

const size = 512;

const loadTile = (z, x, y) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./mandelbrotWorker.js", import.meta.url)
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

    worker.postMessage({ z, x, y, size });
  });
};

const map = new Map({
  target: "map",
  layers: [
    new TileLayer({
      preload: Infinity,
      source: new DataTile({
        tileSize: size,
        loader: loadTile,
      }),
    }),
  ],
  view: new View({
    center: [0, 0],
    zoom: 0,
  }),
});
