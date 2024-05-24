import { Map } from "ol";
import TileLayer from "ol/layer/WebGLTile";
import React, {
  createContext,
  useState,
  useContext,
  ReactNode,
  useEffect,
  useRef,
} from "react";

const BASE_NUDGE = 156543.03392804096;

type ControlValues = {
  bandOffset: number;
  bandSpeed: number;
  hueOffset: number;
  hueSpeed: number;
  animationSpeed: number;
  animatingColor: boolean;
  paletteScale: number;
  bandSpacing: number;
  bandContrast: number;
  bandHueSpeed: number;
  saturation: number;
  lightness: number;
};

interface AppContextType {
  fractalMap: React.MutableRefObject<Map | undefined>;
  tileLayer: React.MutableRefObject<TileLayer | undefined>;
  controlValues: ControlValues;
  setControlValues: React.Dispatch<React.SetStateAction<ControlValues>>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

interface AnimationProviderProps {
  children: ReactNode;
}

export const AppProvider: React.FC<AnimationProviderProps> = ({ children }) => {
  const [controlValues, setControlValues] = useState({
    bandOffset: 0,
    bandSpeed: 1,
    hueOffset: 0,
    hueSpeed: 1,
    animationSpeed: 5,
    animatingColor: false,
    paletteScale: 5,
    bandSpacing: 3,
    bandContrast: 0.28,
    bandHueSpeed: 0.5,
    saturation: 0.8,
    lightness: 1,
  });
  const fractalMap = useRef<Map | undefined>(undefined);
  const tileLayer = useRef<TileLayer | undefined>(undefined);
  // const [bandOffset, setBandOffset] = useState(0);
  // const [bandSpeed, setBandSpeed] = useState(1);
  // const [hueOffset, setHueOffset] = useState(0);
  // const [hueSpeed, setHueSpeed] = useState(1);
  // const [animationSpeed, setAnimationSpeed] = useState(5);
  // const [animatingColor, setAnimatingColor] = useState(false);
  // const [paletteScale, setPaletteScale] = useState(5);
  // const [bandSpacing, setBandSpacing] = useState(3);
  // const [bandContrast, setBandContrast] = useState(0.28);
  // const [bandHueSpeed, setBandHueSpeed] = useState(0.5);
  // const [saturation, setSaturation] = useState(0.8);
  // const [lightness, setLightness] = useState(1);

  const handleKey = (event: KeyboardEvent) => {
    const mapView = fractalMap.current?.getView();
    const zoom = mapView?.getZoom();

    if (!mapView || !zoom) {
      return;
    }

    switch (event.key) {
      case " ":
        event.preventDefault();
        if (controlValues.animatingColor) {
          setControlValues({ ...controlValues, animatingColor: false });
        } else {
          setControlValues({ ...controlValues, animatingColor: true });
        }
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

  useEffect(() => {
    document.addEventListener("keydown", handleKey);
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
      console.log("in useEffect");
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

  let prevFrameTime: number | undefined = undefined;

  const animateColor: FrameRequestCallback = (timestamp) => {
    const frameDuration = 1000 / 2 ** controlValues.animationSpeed;

    if (!prevFrameTime) {
      prevFrameTime = timestamp;
    }
    const elapsed = timestamp - prevFrameTime;
    prevFrameTime = timestamp;
    const framesPassed = elapsed / frameDuration;

    const bandStep = (Math.PI / 60) * controlValues.bandSpeed * framesPassed;
    let newBandOffset = controlValues.bandOffset + bandStep;
    if (newBandOffset > Math.PI) {
      newBandOffset -= Math.PI * 2;
    }
    setControlValues({ ...controlValues, bandOffset: newBandOffset });

    const hueStep = controlValues.hueSpeed * framesPassed;
    let newHueOffset = controlValues.hueOffset - hueStep;
    if (controlValues.hueOffset < -180) {
      newHueOffset += 360;
    }
    setControlValues({ ...controlValues, hueOffset: newHueOffset });

    if (controlValues.animatingColor) {
      requestAnimationFrame(animateColor);
    } else {
      prevFrameTime = undefined;
    }
  };

  useEffect(() => {
    if (controlValues.animatingColor) {
      requestAnimationFrame(animateColor);
    } else {
      setControlValues({ ...controlValues, animatingColor: false });
    }
  }, [controlValues.animatingColor]);

  return (
    <AppContext.Provider
      value={{
        fractalMap,
        tileLayer,
        controlValues,
        setControlValues,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = (): AppContextType => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useAppContext must be used within an AppContextProvider");
  }
  return context;
};
