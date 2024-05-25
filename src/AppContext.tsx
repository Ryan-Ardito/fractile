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
