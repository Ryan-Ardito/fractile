import React, {
  createContext,
  useState,
  useContext,
  ReactNode,
  useEffect,
} from "react";

interface AppContextType {
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

  let prevFrameTime: number | undefined = undefined;

  const animateColor: FrameRequestCallback = (timestamp) => {
    const frameDuration = 1000 / 2 ** animationSpeed;

    if (!prevFrameTime) {
      prevFrameTime = timestamp;
    }
    if (!prevFrameTime) throw "oops";
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
    setAnimatingColor(false);
  }, [hueOffset, bandOffset]);

  useEffect(() => {
    if (animatingColor) {
      requestAnimationFrame(animateColor);
    }
  }, [animatingColor]);

  return (
    <AppContext.Provider
      value={{
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
    throw new Error("useAnimation must be used within an AnimationProvider");
  }
  return context;
};
