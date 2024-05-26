import { Map } from "ol";
import TileLayer from "ol/layer/WebGLTile";
import React, {
  createContext,
  useState,
  useContext,
  ReactNode,
  useRef,
} from "react";

type ControlValues = {
  hueDirection: number;
  bandDirection: number;
  isAnimating: boolean;
  menuCollapsed: boolean;
  bandOffset: number;
  hueOffset: number;
  animationSpeed: number;
  paletteScale: number;
  bandSpacing: number;
  bandContrast: number;
  bandHueSpeed: number;
  saturation: number;
  lightness: number;
};

type AppContextType = {
  fractalMap: React.MutableRefObject<Map | undefined>;
  tileLayer: React.MutableRefObject<TileLayer | undefined>;
  controlValues: ControlValues;
  setControlValues: React.Dispatch<React.SetStateAction<ControlValues>>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

type AnimationProviderProps = {
  children: ReactNode;
}

export const AppProvider: React.FC<AnimationProviderProps> = ({ children }) => {
  const fractalMap = useRef<Map | undefined>(undefined);
  const tileLayer = useRef<TileLayer | undefined>(undefined);
  const [controlValues, setControlValues] = useState({
    hueDirection: -1,
    bandDirection: 1,
    isAnimating: false,
    menuCollapsed: true,
    bandOffset: 0,
    hueOffset: 0,
    animationSpeed: 5,
    paletteScale: 5,
    bandSpacing: 3,
    bandContrast: 0.28,
    bandHueSpeed: 0.5,
    saturation: 0.8,
    lightness: 1,
  });

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
