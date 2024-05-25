import { Menu } from "./components/Menu";
import { AboutInfo } from "./components/AboutInfo";
import { MapComponent } from "./components/Map";
import { useAppContext } from "./AppContext";
import { useEffect, useRef } from "react";

const BASE_NUDGE = 156543.03392804096;
const MOUSE_HIDE_DELAY = 1000;

function App() {
  const { fractalMap, controlValues, setControlValues } = useAppContext();

  const prevFrameTime = useRef<number | undefined>();
  const frameId = useRef<number | undefined>();
  const controlValuesRef = useRef(controlValues);

  const timeout = useRef<number | undefined>();

  useEffect(() => {
    const hideMouseCursor = () => {
      if (document.body.style.cursor !== "none") {
        document.body.style.cursor = "none";
      }
    };

    const showMouseCursor = () => {
      clearTimeout(timeout.current);
      if (document.body.style.cursor !== "default") {
        document.body.style.cursor = "default";
      }
    };

    const handleWakeUp = () => {
      showMouseCursor();
      timeout.current = setTimeout(hideMouseCursor, MOUSE_HIDE_DELAY);
    };

    document.addEventListener("mousemove", handleWakeUp);
    document.addEventListener("mousedown", handleWakeUp);

    return () => {
      document.removeEventListener("mousemove", handleWakeUp);
      document.removeEventListener("mousedown", handleWakeUp);
    };
  }, []);

  useEffect(() => {
    controlValuesRef.current = controlValues;
  }, [controlValues]);

  const animateColor: FrameRequestCallback = (timestamp) => {
    const frameDuration = 1000 / 2 ** controlValuesRef.current.animationSpeed;
    if (!prevFrameTime.current) {
      prevFrameTime.current = timestamp;
    }
    const elapsed = timestamp - prevFrameTime.current;
    prevFrameTime.current = timestamp;
    const framesPassed = elapsed / frameDuration;
    const bandHueSpeed = controlValuesRef.current.bandHueSpeed;

    const bandSpeed = Math.min(1, (1 - bandHueSpeed) * 2);
    const bandStep = (Math.PI / 60) * bandSpeed * framesPassed;
    const bandOffset = controlValuesRef.current.bandOffset * Math.PI;
    let newBandOffset = bandOffset + bandStep;
    if (newBandOffset > Math.PI) {
      newBandOffset -= Math.PI * 2;
    }

    const hueSpeed = Math.min(1, bandHueSpeed * 2);
    const hueStep = hueSpeed * framesPassed;
    const hueOffset = controlValuesRef.current.hueOffset;
    let newHueOffset = hueOffset - hueStep;
    if (controlValuesRef.current.hueOffset < -180) {
      newHueOffset += 360;
    }

    setControlValues({
      ...controlValuesRef.current,
      bandOffset: newBandOffset / Math.PI,
      hueOffset: newHueOffset,
    });

    if (controlValuesRef.current.animatingColor) {
      frameId.current = requestAnimationFrame(animateColor);
    } else {
      prevFrameTime.current = undefined;
      frameId.current = undefined;
    }
  };

  useEffect(() => {
    if (controlValues.animatingColor) {
      frameId.current = requestAnimationFrame(animateColor);
    }
    return () => {
      if (frameId.current) {
        cancelAnimationFrame(frameId.current);
        prevFrameTime.current = undefined;
        frameId.current = undefined;
      }
    };
  }, [controlValues.animatingColor]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const mapView = fractalMap.current?.getView();
      const zoom = mapView?.getZoom();
      const menuCollapsed = controlValues.menuCollapsed;

      if (!mapView || !zoom || !menuCollapsed) {
        return;
      }
      switch (event.key) {
        case "ArrowUp":
          mapView.adjustCenter([0, BASE_NUDGE / Math.pow(2, zoom)]);
          break;
        case "ArrowDown":
          mapView.adjustCenter([0, (-1 * BASE_NUDGE) / Math.pow(2, zoom)]);
          break;
        case "ArrowRight":
          mapView.adjustCenter([BASE_NUDGE / Math.pow(2, zoom), 0]);
          break;
        case "ArrowLeft":
          mapView.adjustCenter([(-1 * BASE_NUDGE) / Math.pow(2, zoom), 0]);
          break;
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [controlValues.menuCollapsed]);

  // document.addEventListener("DOMContentLoaded", () => {
  //   document.addEventListener("keydown", (event) => {

  //     if (event.key === "Escape" || event.key === "Esc") {
  //     }
  //   });
  // });
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case " ":
          event.preventDefault();
          setControlValues((vals) => {
            return {
              ...vals,
              animatingColor: !vals.animatingColor,
            };
          });
          break;

        case "Escape":
          setControlValues((vals) => {
            return { ...vals, menuCollapsed: true };
          });
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  return (
    <>
      <MapComponent />
      <Menu />
      <AboutInfo />
    </>
  );
}

export default App;
