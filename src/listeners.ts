import { Coordinate } from "ol/coordinate";
import { layer, map, view } from "./map";
import {
  bandOffset,
  bandSpeed,
  hueOffset,
  hueSpeed,
  setAnimationSpeed,
  setBandOffset,
  setBandSpeed,
  setHueOffset,
  setHueSpeed,
  stopAnimation,
  toggleAnimation,
} from "./animation";

type ZoomCoords = [number, Coordinate];

const BASE_NUDGE = 156543.03392804096;

const mapView = map.getView();
let shouldUpdate = true;

export const locationFromHash = (hash: string): ZoomCoords => {
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
          view.adjustCenter([0, BASE_NUDGE / Math.pow(2, zoom)]);
          break;
        case "ArrowDown":
          view.adjustCenter([0, (-1 * BASE_NUDGE) / Math.pow(2, zoom)]);
          break;
        case "ArrowRight":
          view.adjustCenter([BASE_NUDGE / Math.pow(2, zoom), 0]);
          break;
        case "ArrowLeft":
          view.adjustCenter([(-1 * BASE_NUDGE) / Math.pow(2, zoom), 0]);
          break;
      }
    }

    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      toggleAnimation();
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

      if (target.id === "hueOffset" && hueSpeed > 0) {
        stopAnimation();
      }
      if (target.id === "bandOffset" && bandSpeed > 0) {
        stopAnimation();
      }

      switch (target.id) {
        case "animationSpeed":
          setAnimationSpeed(parseFloat(target.value));
          break;
        case "paletteScale":
          const paletteScale = 2 ** (parseFloat(target.value) - 5);
          layer.updateStyleVariables({ ["paletteScale"]: paletteScale });
          break;
        case "bandSpacing":
          const bandSpacing = 2 ** parseFloat(target.value);
          layer.updateStyleVariables({ ["bandSpacing"]: bandSpacing });
          break;
        case "bandHueSpeed":
          const val = parseFloat(target.value);
          setBandSpeed(Math.min(1, (1 - val) * 2));
          setHueSpeed(Math.min(1, val * 2));
          break;
        case "hueOffset":
          setHueOffset(parseInt(target.value));
          layer.updateStyleVariables({ ["hueOffset"]: hueOffset });
          break;
        case "bandOffset":
          setBandOffset(parseFloat(target.value) * Math.PI);
          layer.updateStyleVariables({ ["bandOffset"]: bandOffset });
          break;
        default:
          const id = target.id;
          const value = parseFloat(target.value);
          layer.updateStyleVariables({ [id]: value });
          break;
      }
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
