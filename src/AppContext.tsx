import { Map } from "ol";
import TileLayer from "ol/layer/WebGLTile";
import React, {
  createContext,
  useContext,
  ReactNode,
  useRef,
  useReducer,
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
  updateControlValues: React.Dispatch<Action>;
};

type AnimationProviderProps = {
  children: ReactNode;
};

type Action =
  | {
      type: "UPDATE_ANIMATION";
      payload: { newBandOffset: number; newHueOffset: number };
    }
  | { type: "SET_HUE_DIRECTION"; payload: number }
  | { type: "SET_BAND_DIRECTION"; payload: number }
  | { type: "TOGGLE_ANIMATING" }
  | { type: "TOGGLE_MENU_COLLAPSED" }
  | { type: "SET_MENU_COLLAPSED"; payload: boolean }
  | { type: "SET_BAND_OFFSET"; payload: number }
  | { type: "SET_HUE_OFFSET"; payload: number }
  | { type: "SET_ANIMATION_SPEED"; payload: number }
  | { type: "SET_PALETTE_SCALE"; payload: number }
  | { type: "SET_BAND_SPACING"; payload: number }
  | { type: "SET_BAND_CONTRAST"; payload: number }
  | { type: "SET_BAND_HUE_SPEED"; payload: number }
  | { type: "SET_SATURATION"; payload: number }
  | { type: "SET_LIGHTNESS"; payload: number };

// Reducer function
const controlValuesReducer = (
  state: ControlValues,
  action: Action
): ControlValues => {
  switch (action.type) {
    case "UPDATE_ANIMATION":
      return {
        ...state,
        bandOffset: action.payload.newBandOffset / Math.PI,
        hueOffset: action.payload.newHueOffset,
      };
    case "SET_HUE_DIRECTION":
      return { ...state, hueDirection: action.payload };
    case "SET_BAND_DIRECTION":
      return { ...state, bandDirection: action.payload };
    case "TOGGLE_ANIMATING":
      return { ...state, isAnimating: !state.isAnimating };
    case "TOGGLE_MENU_COLLAPSED":
      return { ...state, menuCollapsed: !state.menuCollapsed };
    case "SET_MENU_COLLAPSED":
      return { ...state, menuCollapsed: action.payload };
    case "SET_BAND_OFFSET":
      if (state.bandHueSpeed != 1) {
        return { ...state, isAnimating: false, bandOffset: action.payload };
      }
      return { ...state, bandOffset: action.payload };
    case "SET_HUE_OFFSET":
      if (state.bandHueSpeed != 0) {
        return { ...state, isAnimating: false, hueOffset: action.payload };
      }
      return { ...state, hueOffset: action.payload };
    case "SET_ANIMATION_SPEED":
      return { ...state, animationSpeed: action.payload };
    case "SET_PALETTE_SCALE":
      return { ...state, paletteScale: action.payload };
    case "SET_BAND_SPACING":
      return { ...state, bandSpacing: action.payload };
    case "SET_BAND_CONTRAST":
      return { ...state, bandContrast: action.payload };
    case "SET_BAND_HUE_SPEED":
      return { ...state, bandHueSpeed: action.payload };
    case "SET_SATURATION":
      return { ...state, saturation: action.payload };
    case "SET_LIGHTNESS":
      return { ...state, lightness: action.payload };
    default:
      return state;
  }
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<AnimationProviderProps> = ({ children }) => {
  const fractalMap = useRef<Map | undefined>(undefined);
  const tileLayer = useRef<TileLayer | undefined>(undefined);
  const [controlValues, updateControlValues] = useReducer(
    controlValuesReducer,
    {
      hueDirection: -1,
      bandDirection: 1,
      isAnimating: false,
      menuCollapsed: true,
      bandOffset: 0,
      hueOffset: 0,
      animationSpeed: 128,
      paletteScale: 5,
      bandSpacing: 3,
      bandContrast: 0.28,
      bandHueSpeed: 0.5,
      saturation: 0.8,
      lightness: 1,
    }
  );

  return (
    <AppContext.Provider
      value={{
        fractalMap,
        tileLayer,
        controlValues,
        updateControlValues,
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
