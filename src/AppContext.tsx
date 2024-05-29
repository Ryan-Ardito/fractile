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

type AnimationValues = {
  hueDirection: number;
  bandDirection: number;
  isAnimating: boolean;
  bandOffset: number;
  hueOffset: number;
  frameDuration: number;
  bandHueSpeed: number;
};

type AppContextType = {
  fractalMap: React.MutableRefObject<Map | undefined>;
  tileLayer: React.MutableRefObject<TileLayer | undefined>;
  controlValues: ControlValues;
  updateControlValues: React.Dispatch<Action>;
  animationValues: React.MutableRefObject<AnimationValues>;
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

const AppContext = createContext<AppContextType | undefined>(undefined);

const DEFAULT_VALUES: AnimationValues = {
  hueDirection: -1,
  bandDirection: 1,
  isAnimating: false,
  bandOffset: 0,
  hueOffset: 0,
  frameDuration: 60000 / 128,
  bandHueSpeed: 0.5,
};

export const AppProvider: React.FC<AnimationProviderProps> = ({ children }) => {
  const fractalMap = useRef<Map | undefined>(undefined);
  const tileLayer = useRef<TileLayer | undefined>(undefined);

  const animationValues = useRef(DEFAULT_VALUES);

  const controlValuesReducer = (
    state: ControlValues,
    action: Action
  ): ControlValues => {
    switch (action.type) {
      case "UPDATE_ANIMATION":
        const newBandOffset = action.payload.newBandOffset;
        const newHueOffset = action.payload.newHueOffset;
        if (tileLayer.current) {
          tileLayer.current.updateStyleVariables({
            bandOffset: newBandOffset,
            hueOffset: newHueOffset,
          });
        }
        return {
          ...state,
          bandOffset: newBandOffset,
          hueOffset: newHueOffset,
        };

      case "SET_HUE_DIRECTION":
        const hueDirection = action.payload;
        animationValues.current.hueDirection = hueDirection;
        return { ...state, hueDirection };

      case "SET_BAND_DIRECTION":
        const bandDirection = action.payload;
        animationValues.current.bandDirection = bandDirection;
        return { ...state, bandDirection };

      case "TOGGLE_ANIMATING":
        const isAnimating = !state.isAnimating;
        animationValues.current.isAnimating = isAnimating;
        return { ...state, isAnimating };

      case "TOGGLE_MENU_COLLAPSED":
        return { ...state, menuCollapsed: !state.menuCollapsed };

      case "SET_MENU_COLLAPSED":
        return { ...state, menuCollapsed: action.payload };

      case "SET_BAND_OFFSET":
        animationValues.current.bandOffset = action.payload * Math.PI;
        const adjBandOffset = action.payload * Math.PI;
        if (tileLayer.current) {
          tileLayer.current.updateStyleVariables({
            bandOffset: adjBandOffset,
          });
        }
        if (state.bandHueSpeed != 1) {
          return { ...state, isAnimating: false, bandOffset: action.payload };
        }
        return { ...state, bandOffset: action.payload };

      case "SET_HUE_OFFSET":
        animationValues.current.hueOffset = action.payload;
        if (tileLayer.current) {
          tileLayer.current.updateStyleVariables({
            hueOffset: action.payload,
          });
        }
        if (state.bandHueSpeed != 0) {
          return { ...state, isAnimating: false, hueOffset: action.payload };
        }
        return { ...state, hueOffset: action.payload };

      case "SET_ANIMATION_SPEED":
        animationValues.current.frameDuration = 60000 / action.payload;
        return { ...state, animationSpeed: action.payload };

      case "SET_PALETTE_SCALE":
        const adjPaletteScale = 1 / 2 ** (action.payload - 5);
        if (tileLayer.current) {
          tileLayer.current.updateStyleVariables({
            paletteScale: adjPaletteScale,
          });
        }
        return { ...state, paletteScale: action.payload };

      case "SET_BAND_SPACING":
        const adjBandSpacing = 1 / 2 ** action.payload;
        if (tileLayer.current) {
          tileLayer.current.updateStyleVariables({
            bandSpacing: adjBandSpacing,
          });
        }
        return { ...state, bandSpacing: action.payload };

      case "SET_BAND_CONTRAST":
        if (tileLayer.current) {
          tileLayer.current.updateStyleVariables({
            bandSpacing: action.payload,
          });
        }
        return { ...state, bandContrast: action.payload };

      case "SET_BAND_HUE_SPEED":
        animationValues.current.bandHueSpeed = action.payload;
        return { ...state, bandHueSpeed: action.payload };

      case "SET_SATURATION":
        if (tileLayer.current) {
          tileLayer.current.updateStyleVariables({
            saturation: action.payload,
          });
        }
        return { ...state, saturation: action.payload };

      case "SET_LIGHTNESS":
        if (tileLayer.current) {
          tileLayer.current.updateStyleVariables({
            lightness: action.payload,
          });
        }
        return { ...state, lightness: action.payload };
      default:
        return state;
    }
  };

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
        animationValues,
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
