import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import View from "ol/View";
import { Extent } from "ol/extent";
import { colorPixelExpression } from "./colorGL";
import { Coordinate } from "ol/coordinate";

type ZoomCoords = [number, Coordinate];

const TILE_SIZE = 256;
const BASE_ITERATIONS = 1024;
const BASE_PIXEL_WIDTH = 156543.03392804096;

const locationFromHash = (hash: string): ZoomCoords => {
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

let zoom = 4;
let center: Coordinate = [-1200000, 0];

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

const extent: Extent = [-30000000, -15000000, 30000000, 15000000];

const view = new View({
  multiWorld: true,
  extent,
  minZoom: 3,
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

const startAnimation = () => {
  if (animatingColor) {
    return;
  }

  animatingColor = true;
  requestAnimationFrame(animateColor);
  const animateButton = document.getElementById("animateButton");
  if (animateButton) {
    animateButton.textContent = "stop";
  }
};

const stopAnimation = () => {
  animatingColor = false;
  const animateButton = document.getElementById("animateButton");
  if (animateButton) {
    animateButton.textContent = "animate";
  }
};

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

let animatingColor = false;
let bandOffset = 0;
let hue = 0;

let prevFrameTime: number | null = null;
let animationSpeed = 5;

const animateColor: FrameRequestCallback = (timestamp) => {
  const frameDuration = 1000 / 2 ** animationSpeed;

  if (!prevFrameTime) prevFrameTime = timestamp;
  const elapsed = timestamp - prevFrameTime;
  prevFrameTime = timestamp;
  const framesPassed = elapsed / frameDuration;

  bandOffset = bandOffset + (Math.PI / 10) * framesPassed;
  if (bandOffset >= Number.MAX_SAFE_INTEGER) {
    bandOffset = 0;
  }
  layer.updateStyleVariables({ ["bandOffset"]: bandOffset });

  if (hue <= -178) {
    hue = 179 - 1 * framesPassed;
  } else {
    hue -= 1 * framesPassed;
  }
  layer.updateStyleVariables({ ["hueOffset"]: hue });

  const hueInput = document.getElementById("hueOffset") as HTMLInputElement;
  const hueLabel = hueInput.previousElementSibling;
  if (hueInput && hueLabel) {
    const adjHue = Math.round(hue);
    hueInput.value = adjHue.toString();
    hueLabel.textContent = adjHue.toString();
  }

  if (animatingColor) {
    requestAnimationFrame(animateColor);
  } else {
    prevFrameTime = null;
  }
};

map.on("moveend", updatePermalink);

window.addEventListener("hashchange", (ev) => {
  try {
    const url = ev.newURL;
    const hash = url.substring(url.indexOf("#"));
    const [zoom, center] = locationFromHash(hash);
    map.getView().setZoom(zoom);
    map.getView().setCenter(center);
    const state = {
      zoom: mapView.getZoom(),
      center: mapView.getCenter(),
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
  document.addEventListener("keydown", (event) => {
    const zoom = view.getZoom();
    const floatingBox = document.getElementById("floatingBox");
    if (zoom && floatingBox?.style.visibility !== "visible") {
      switch (event.key) {
        case "ArrowUp":
          view.adjustCenter([0, BASE_PIXEL_WIDTH / Math.pow(2, zoom)]);
          break;
        case "ArrowDown":
          view.adjustCenter([0, (-1 * BASE_PIXEL_WIDTH) / Math.pow(2, zoom)]);
          break;
        case "ArrowRight":
          view.adjustCenter([BASE_PIXEL_WIDTH / Math.pow(2, zoom), 0]);
          break;
        case "ArrowLeft":
          view.adjustCenter([(-1 * BASE_PIXEL_WIDTH) / Math.pow(2, zoom), 0]);
          break;
        default:
          break;
      }
    }

    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      if (!animatingColor) {
        startAnimation();
      } else {
        stopAnimation();
      }
    }

    if (event.key === "Escape" || event.key === "Esc") {
      const menuButton = document.getElementById("menuButton");
      const floatingBox = document.getElementById("floatingBox");
      if (floatingBox && menuButton) {
        floatingBox.style.visibility = "collapse";
        floatingBox.style.opacity = "0%";
        menuButton.textContent = "menu";
      }
    }
  });

  const inputs =
    document.querySelectorAll<HTMLInputElement>("#floatingBox input");

  inputs.forEach((input, index) => {
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;

      if (target.id === "hueOffset") {
        hue = parseInt(target.value);
      }

      if (animateButton) {
        if (target.id === "hueOffset" || target.id === "bandOffset") {
          animatingColor = false;
          animateButton.textContent = "animate";
        }
      }

      if (target.id === "animationSpeed") {
        animationSpeed = parseFloat(target.value);
        return;
      }

      if (target.id === "paletteScale") {
        const paletteScale = 2 ** (parseFloat(target.value) - 5);
        layer.updateStyleVariables({ ["paletteScale"]: paletteScale });
        return;
      }

      if (target.id === "bandSpacing") {
        const bandSpacing = 2 ** (parseFloat(target.value) - 2);
        layer.updateStyleVariables({ ["bandSpacing"]: bandSpacing });
        return;
      }

      const id = target.id;
      const value = parseFloat(target.value);
      layer.updateStyleVariables({ [id]: value });
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIndex = (index + 1) % inputs.length;
        inputs[nextIndex].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIndex = (index - 1 + inputs.length) % inputs.length;
        inputs[prevIndex].focus();
      }
    });
  });
});

const menuButton = document.getElementById("menuButton");
const floatingBox = document.getElementById("floatingBox");

if (menuButton && floatingBox) {
  menuButton.onclick = () => {
    switch (floatingBox.style.visibility) {
      case "visible":
        floatingBox.style.visibility = "collapse";
        floatingBox.style.opacity = "0%";
        menuButton.textContent = "menu";
        break;
      default:
        floatingBox.style.visibility = "visible";
        floatingBox.style.opacity = "100%";
        menuButton.textContent = "close";
    }
  };
} else {
  console.error("Color menu not found.");
}

const animateButton = document.getElementById("animateButton");
if (animateButton) {
  animateButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!animatingColor) {
      startAnimation();
    } else {
      stopAnimation();
    }
  });
}
