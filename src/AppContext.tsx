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

interface AppContextType {
  fractalMap: React.MutableRefObject<Map | undefined>;
  tileLayer: React.MutableRefObject<TileLayer | undefined>;
  bandOffset: number;
  setBandOffset: React.Dispatch<React.SetStateAction<number>>;
  bandSpeed: number;
  setBandSpeed: React.Dispatch<React.SetStateAction<number>>;
  hueOffset: number;
  setHueOffset: React.Dispatch<React.SetStateAction<number>>;
  hueSpeed: number;
  setHueSpeed: React.Dispatch<React.SetStateAction<number>>;
  animationSpeed: number;
  setAnimationSpeed: React.Dispatch<React.SetStateAction<number>>;
  animatingColor: boolean;
  setAnimatingColor: React.Dispatch<React.SetStateAction<boolean>>;
  paletteScale: number;
  setPaletteScale: React.Dispatch<React.SetStateAction<number>>;
  bandSpacing: number;
  setBandSpacing: React.Dispatch<React.SetStateAction<number>>;
  bandContrast: number;
  setBandContrast: React.Dispatch<React.SetStateAction<number>>;
  bandHueSpeed: number;
  setBandHueSpeed: React.Dispatch<React.SetStateAction<number>>;
  saturation: number;
  setSaturation: React.Dispatch<React.SetStateAction<number>>;
  lightness: number;
  setLightness: React.Dispatch<React.SetStateAction<number>>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

interface AnimationProviderProps {
  children: ReactNode;
}

export const AppProvider: React.FC<AnimationProviderProps> = ({ children }) => {
  const fractalMap = useRef<Map | undefined>(undefined);
  const tileLayer = useRef<TileLayer | undefined>(undefined);
  const [bandOffset, setBandOffset] = useState(0);
  const [bandSpeed, setBandSpeed] = useState(1);
  const [hueOffset, setHueOffset] = useState(0);
  const [hueSpeed, setHueSpeed] = useState(1);
  const [animationSpeed, setAnimationSpeed] = useState(5);
  const [animatingColor, setAnimatingColor] = useState(false);
  const [paletteScale, setPaletteScale] = useState(5);
  const [bandSpacing, setBandSpacing] = useState(3);
  const [bandContrast, setBandContrast] = useState(0.28);
  const [bandHueSpeed, setBandHueSpeed] = useState(0.5);
  const [saturation, setSaturation] = useState(0.8);
  const [lightness, setLightness] = useState(1);

  const mapView = fractalMap.current?.getView();
  const zoom = mapView?.getZoom();
  if (mapView && zoom) {
    document.addEventListener("keydown", (event) => {
      switch (event.key) {
        case " ":
          event.preventDefault();
          if (animatingColor) {
            setAnimatingColor(false);
          } else {
            setAnimatingColor(false);
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
    });
  }

  useEffect(() => {
    if (tileLayer.current) {
      const adjPaletteScale = 2 ** (paletteScale - 5);
      tileLayer.current.updateStyleVariables({
        ["paletteScale"]: adjPaletteScale,
      });
    }
  }, [paletteScale]);

  useEffect(() => {
    if (tileLayer.current) {
      const adjBandSpacing = 2 ** bandSpacing;
      tileLayer.current.updateStyleVariables({
        ["bandSpacing"]: adjBandSpacing,
      });
    }
  }, [bandSpacing]);

  useEffect(() => {
    if (tileLayer.current) {
      tileLayer.current.updateStyleVariables({
        ["bandContrast"]: bandContrast,
      });
      console.log("in useEffect");
    }
  }, [bandContrast]);

  useEffect(() => {
    if (tileLayer.current) {
      tileLayer.current.updateStyleVariables({ ["hueOffset"]: hueOffset });
    }
  }, [hueOffset]);

  useEffect(() => {
    if (tileLayer.current) {
      const adjBandOffset = bandOffset * Math.PI;
      tileLayer.current.updateStyleVariables({ ["bandOffset"]: adjBandOffset });
    }
  }, [bandOffset]);

  useEffect(() => {
    if (tileLayer.current) {
      tileLayer.current.updateStyleVariables({ ["saturation"]: saturation });
    }
  }, [saturation]);

  useEffect(() => {
    if (tileLayer.current) {
      tileLayer.current.updateStyleVariables({ ["lightness"]: lightness });
    }
  }, [lightness]);

  let prevFrameTime: number | undefined = undefined;

  const animateColor: FrameRequestCallback = (timestamp) => {
    const frameDuration = 1000 / 2 ** animationSpeed;

    if (!prevFrameTime) {
      prevFrameTime = timestamp;
    }
    const elapsed = timestamp - prevFrameTime;
    prevFrameTime = timestamp;
    const framesPassed = elapsed / frameDuration;

    const bandStep = (Math.PI / 60) * bandSpeed * framesPassed;
    let newBandOffset = bandOffset + bandStep;
    if (newBandOffset > Math.PI) {
      newBandOffset -= Math.PI * 2;
    }
    setBandOffset(newBandOffset);

    const hueStep = hueSpeed * framesPassed;
    let newHueOffset = hueOffset - hueStep;
    if (hueOffset < -180) {
      newHueOffset += 360;
    }
    setHueOffset(newHueOffset);

    if (animatingColor) {
      requestAnimationFrame(animateColor);
    } else {
      prevFrameTime = undefined;
    }
  };

  useEffect(() => {
    if (animatingColor) {
      requestAnimationFrame(animateColor);
    } else {
      setAnimatingColor(false);
    }
  }, [animatingColor]);

  return (
    <AppContext.Provider
      value={{
        fractalMap,
        tileLayer,
        bandOffset,
        setBandOffset,
        bandSpeed,
        setBandSpeed,
        hueOffset,
        setHueOffset,
        hueSpeed,
        setHueSpeed,
        animationSpeed,
        setAnimationSpeed,
        animatingColor,
        setAnimatingColor,
        paletteScale,
        setPaletteScale,
        bandSpacing,
        setBandSpacing,
        bandContrast,
        setBandContrast,
        bandHueSpeed,
        setBandHueSpeed,
        saturation,
        setSaturation,
        lightness,
        setLightness,
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
