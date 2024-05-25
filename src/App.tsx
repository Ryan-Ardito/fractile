import { Menu } from "./components/Menu";
import { AboutInfo } from "./components/AboutInfo";
import { MapComponent } from "./components/Map";
import { useAppContext } from "./AppContext";
import { useEffect, useRef } from "react";

const BASE_NUDGE = 156543.03392804096;

function App() {
  const { fractalMap, tileLayer, controlValues, setControlValues } =
    useAppContext();

  const prevFrameTime = useRef<number | undefined>(undefined);
  const prevFrameRef = useRef<number | undefined>(undefined);
  const controlValuesRef = useRef(controlValues);

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

    const bandStep =
      (Math.PI / 60) * controlValuesRef.current.bandSpeed * framesPassed;
    let newBandOffset =
      controlValuesRef.current.bandOffset * Math.PI + bandStep;
    if (newBandOffset > Math.PI) {
      newBandOffset -= Math.PI * 2;
    }

    const hueStep = controlValuesRef.current.hueSpeed * framesPassed;
    let newHueOffset = controlValuesRef.current.hueOffset - hueStep;
    if (controlValuesRef.current.hueOffset < -180) {
      newHueOffset += 360;
    }
    setControlValues({
      ...controlValuesRef.current,
      bandOffset: newBandOffset / Math.PI,
      hueOffset: newHueOffset,
    });

    if (controlValuesRef.current.animatingColor) {
      prevFrameRef.current = requestAnimationFrame(animateColor);
    } else {
      prevFrameTime.current = undefined;
      prevFrameRef.current = undefined;
    }
  };

  useEffect(() => {
    if (controlValues.animatingColor) {
      prevFrameRef.current = requestAnimationFrame(animateColor);
    }
    return () => {
      if (prevFrameRef.current) {
        cancelAnimationFrame(prevFrameRef.current);
        prevFrameTime.current = undefined;
        prevFrameRef.current = undefined;
      }
    };
  }, [controlValues.animatingColor]);

  useEffect(() => {
    console.log("in key handler useEffect");
    const handleKey = (event: KeyboardEvent) => {
      const mapView = fractalMap.current?.getView();
      const zoom = mapView?.getZoom();

      if (!mapView || !zoom) {
        return;
      }

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
  }, []);

  useEffect(() => {
    if (tileLayer.current) {
      const adjPaletteScale = 2 ** (controlValues.paletteScale - 5);
      tileLayer.current.updateStyleVariables({
        ["paletteScale"]: adjPaletteScale,
      });
    }
  }, [controlValues.paletteScale]);

  useEffect(() => {
    if (tileLayer.current) {
      const adjBandSpacing = 2 ** controlValues.bandSpacing;
      tileLayer.current.updateStyleVariables({
        ["bandSpacing"]: adjBandSpacing,
      });
    }
  }, [controlValues.bandSpacing]);

  useEffect(() => {
    if (tileLayer.current) {
      tileLayer.current.updateStyleVariables({
        ["bandContrast"]: controlValues.bandContrast,
      });
    }
  }, [controlValues.bandContrast]);

  useEffect(() => {
    if (tileLayer.current) {
      tileLayer.current.updateStyleVariables({
        ["hueOffset"]: controlValues.hueOffset,
      });
    }
  }, [controlValues.hueOffset]);

  useEffect(() => {
    if (tileLayer.current) {
      const adjBandOffset = controlValues.bandOffset * Math.PI;
      tileLayer.current.updateStyleVariables({ ["bandOffset"]: adjBandOffset });
    }
  }, [controlValues.bandOffset]);

  useEffect(() => {
    if (tileLayer.current) {
      tileLayer.current.updateStyleVariables({
        ["saturation"]: controlValues.saturation,
      });
    }
  }, [controlValues.saturation]);

  useEffect(() => {
    if (tileLayer.current) {
      tileLayer.current.updateStyleVariables({
        ["lightness"]: controlValues.lightness,
      });
    }
  }, [controlValues.lightness]);

  return (
    <>
      <MapComponent />
      <Menu />
      <AboutInfo />
    </>
  );
}

export default App;
