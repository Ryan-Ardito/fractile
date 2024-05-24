import { useState } from "react";
import { useAppContext } from "../AppContext";

export const Menu = () => {
  const { controlValues, setControlValues } = useAppContext();
  const [menuCollapsed, setMenuCollapsed] = useState(true);

  const visibility = menuCollapsed ? "collapse" : "visible";
  const opacity = menuCollapsed ? "0%" : "100%";
  const buttonText = menuCollapsed ? "menu" : "close";

  const onMenuButtonClick = () => {
    setMenuCollapsed(!menuCollapsed);
  };

  const handleSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { id, value } = event.target;
    setControlValues({
      ...controlValues,
      [id]: parseFloat(value),
    });
  };

  return (
    <>
      <button id="menuButton" onClick={onMenuButtonClick}>
        {buttonText}
      </button>
      <div id="floatingBox" style={{ visibility, opacity }}>
        <button
          id="animateButton"
          onClick={() =>
            setControlValues({
              ...controlValues,
              animatingColor: !controlValues.animatingColor,
            })
          }
        >
          {controlValues.animatingColor ? "stop" : "animate"}
        </button>
        <label>
          animation speed: <output>{controlValues.animationSpeed}</output>
          <input
            type="range"
            id="animationSpeed"
            min="1"
            max="10"
            step="0.1"
            value={controlValues.animationSpeed}
            onChange={handleSliderChange}
          />
        </label>
        <label>
          palette scale: <output>{controlValues.paletteScale}</output>
          <input
            type="range"
            id="paletteScale"
            min="1"
            max="10"
            step="0.01"
            value={controlValues.paletteScale}
            onChange={handleSliderChange}
          />
        </label>
        <label>
          band spacing: <output>{controlValues.bandSpacing}</output>
          <input
            type="range"
            id="bandSpacing"
            min="1"
            max="10"
            step="0.005"
            value={controlValues.bandSpacing}
            onChange={handleSliderChange}
          />
        </label>
        <label>
          band contrast: <output>{controlValues.bandContrast}</output>
          <input
            type="range"
            id="bandContrast"
            min="0"
            max="0.5"
            step="0.01"
            value={controlValues.bandContrast}
            onChange={handleSliderChange}
          />
        </label>
        <label>
          band offset: <output>{controlValues.bandOffset}</output>
          <input
            type="range"
            id="bandOffset"
            min="-1"
            max="1"
            step="0.01"
            value={controlValues.bandOffset}
            onChange={handleSliderChange}
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
            value={controlValues.bandHueSpeed}
            list="bandHueMarkers"
            onChange={handleSliderChange}
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
          hue: <output>{controlValues.hueOffset}</output>
          <input
            type="range"
            id="hueOffset"
            min="-180"
            max="179"
            value={controlValues.hueOffset}
            onChange={handleSliderChange}
          />
        </label>
        <label>
          saturation: <output>{controlValues.saturation}</output>
          <input
            type="range"
            id="saturation"
            min="0"
            max="2"
            step="0.01"
            value={controlValues.saturation}
            list="oneMarker"
            onChange={handleSliderChange}
          />
        </label>
        <label>
          lightness: <output>{controlValues.lightness}</output>
          <input
            type="range"
            id="lightness"
            min="0"
            max="2"
            step="0.01"
            value={controlValues.lightness}
            list="oneMarker"
            onChange={handleSliderChange}
          />
        </label>
        <datalist id="oneMarker">
          <option value="1"></option>
        </datalist>
      </div>
    </>
  );
};
