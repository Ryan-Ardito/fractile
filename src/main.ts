import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";
import { Extent } from "ol/extent";
import { colorPixelExpression } from "./colorGL";

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
    color: colorPixelExpression(),
    variables: {
      iterFalloff: 24,
      paletteScale: 1,
      paletteOffset: 0,
      bandSpacing: 10,
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

let animateColor = false;
const frameInterval = 1000 / 60;
let bandOffset = 0;
let hue = 0;
const animateHue: FrameRequestCallback = (e) => {
  layer.updateStyleVariables({ ["bandOffset"]: bandOffset });
  bandOffset = (bandOffset + 0.5) % Number.MAX_SAFE_INTEGER;
  layer.updateStyleVariables({ ["paletteOffset"]: hue });
  hue = (hue - 1) % 360;
  if (animateColor) {
    setTimeout(() => {
      requestAnimationFrame(animateHue);
    }, frameInterval);
  }
};

map.on("moveend", updatePermalink);

window.addEventListener("hashchange", (ev) => {
  try {
    const url = ev.newURL;
    const hash = url.substring(url.indexOf("#"));
    const [zoom, center] = locationFromHash(hash);
    map.getView().setCenter(center);
    map.getView().setZoom(zoom);
    const state = {
      zoom: mapView.getZoom(),
      center: mapView.getCenter(),
    };

    window.history.replaceState(state, "map", hash);
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

document.addEventListener("DOMContentLoaded", () => {
  const inputs: NodeListOf<HTMLInputElement> =
    document.querySelectorAll("#floatingBox input");

  inputs.forEach((input) => {
    input.addEventListener("input", (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (animateButton) {
        if (target.id === "paletteOffset" || target.id === "bandOffset") {
          animateColor = false;
          animateButton.textContent = "animate";
        }
      }
      const id: string = target.id;
      const value: number = parseFloat(target.value);
      layer.updateStyleVariables({ [id]: value });
    });
  });
});

const openButton = document.getElementById("openButton");
const floatingBox = document.getElementById("floatingBox");

if (openButton && floatingBox) {
  openButton.addEventListener("click", () => {
    switch (floatingBox.style.visibility) {
      case "visible":
        floatingBox.style.visibility = "collapse";
        floatingBox.style.opacity = "0%";
        openButton.textContent = "menu";
        break;
      default:
        floatingBox.style.visibility = "visible";
        floatingBox.style.opacity = "100%";
        openButton.textContent = "close";
    }
  });
} else {
  console.error("Color menu not found.");
}

const animateButton = document.getElementById("animateButton");
if (animateButton) {
  animateButton.addEventListener("click", () => {
    switch (animateColor) {
      case false:
        animateColor = true;
        animateButton.textContent = "stop";
        requestAnimationFrame(animateHue);
        break;
      default:
        animateColor = false;
        animateButton.textContent = "animate";
    }
  });
}
