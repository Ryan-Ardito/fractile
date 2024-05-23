import { useState } from "react";
import { useAppContext } from "../AppContext";

interface MenuButtonProps {
  menuCollapsed: boolean;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
}

const MenuButton = ({ menuCollapsed, onClick }: MenuButtonProps) => {
  return (
    <button id="menuButton" onClick={onClick}>
      {menuCollapsed ? "menu" : "close"}
    </button>
  );
};

export const Menu = () => {
  const {
    animatingColor,
    setAnimatingColor,
    animationSpeed,
    setAnimationSpeed,
    bandContrast,
    setBandContrast,
    bandHueSpeed,
    setBandHueSpeed,
    bandOffset,
    setBandOffset,
    bandSpacing,
    setBandSpacing,
    paletteScale,
    setPaletteScale,
    hueOffset,
    setHueOffset,
    saturation,
    setSaturation,
    lightness,
    setLightness,
  } = useAppContext();

  const [menuCollapsed, setMenuCollapsed] = useState(true);

  const onMenuButtonClick = () => {
    setMenuCollapsed(!menuCollapsed);
  };

  const visibility = menuCollapsed ? "collapse" : "visible";
  const opacity = menuCollapsed ? "0%" : "100%";

  return (
    <>
      <MenuButton menuCollapsed onClick={onMenuButtonClick} />
      <div id="floatingBox" style={{ visibility, opacity }}>
        <button
          id="animateButton"
          onClick={() => setAnimatingColor(!animatingColor)}
        >
          {animatingColor ? "stop" : "animate"}
        </button>
        <label>
          animation speed:
          <output>{animationSpeed}</output>
          <input
            type="range"
            id="animationSpeed"
            min="1"
            max="10"
            step="0.1"
            value={animationSpeed}
            onChange={(e) => {
              setAnimationSpeed(parseFloat(e.target.value));
            }}
          />
        </label>
        <label>
          palette scale:
          <output>{paletteScale}</output>
          <input
            type="range"
            id="paletteScale"
            min="1"
            max="10"
            step="0.01"
            value={paletteScale}
            onChange={(e) => {
              setPaletteScale(parseFloat(e.target.value));
            }}
          />
        </label>
        <label>
          band spacing:
          <output>{bandSpacing}</output>
          <input
            type="range"
            id="bandSpacing"
            min="1"
            max="10"
            step="0.005"
            value={bandSpacing}
            onChange={(e) => {
              setBandSpacing(parseFloat(e.target.value));
            }}
          />
        </label>
        <label>
          band contrast:
          <output>{bandContrast}</output>
          <input
            type="range"
            id="bandContrast"
            min="0"
            max="0.5"
            step="0.01"
            value={bandContrast}
            onChange={(e) => {
              setBandContrast(parseFloat(e.target.value));
            }}
          />
        </label>
        <label>
          band offset:
          <output>0</output>
          <input
            type="range"
            id="bandOffset"
            min="-1"
            max="1"
            step="0.01"
            value={bandOffset}
            onChange={(e) => {
              setBandOffset(parseFloat(e.target.value));
            }}
          />
        </label>
        <label>
          band/hue speed
          <input
            type="range"
            id="bandHueSpeed"
            min="0"
            max="1"
            step="0.01"
            value={bandHueSpeed}
            list="bandHueMarkers"
            onChange={(e) => {
              setBandHueSpeed(parseFloat(e.target.value));
            }}
          />
        </label>
        <datalist id="bandHueMarkers">
          <option value="0"></option>
          <option value="0.25"></option>
          <option value="0.5"></option>
          <option value="0.75"></option>
          <option value="1"></option>
        </datalist>
        <label>
          hue:
          <output>{hueOffset}</output>
          <input
            type="range"
            id="hueOffset"
            min="-180"
            max="179"
            value={hueOffset}
            onChange={(e) => {
              setHueOffset(parseFloat(e.target.value));
            }}
          />
        </label>
        <label>
          saturation:
          <output>{saturation}</output>
          <input
            type="range"
            id="saturation"
            min="0"
            max="2"
            step="0.01"
            value={saturation}
            list="oneMarker"
            onChange={(e) => {
              setSaturation(parseFloat(e.target.value));
            }}
          />
        </label>
        <label>
          lightness:
          <output>{lightness}</output>
          <input
            type="range"
            id="lightness"
            min="0"
            max="2"
            step="0.01"
            value={lightness}
            list="oneMarker"
            onChange={(e) => {
              setLightness(parseFloat(e.target.value));
            }}
          />
        </label>
        <datalist id="oneMarker">
          <option value="1"></option>
        </datalist>
      </div>
    </>
  );
};
