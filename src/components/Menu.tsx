import { useRef } from "react";
import { useAppContext } from "../AppContext";

export const Menu = () => {
  const { controlValues, setControlValues } = useAppContext();
  const menuCollapsed = controlValues.menuCollapsed;

  const visibility = menuCollapsed ? "collapse" : "visible";
  const opacity = menuCollapsed ? "0%" : "100%";
  const menuButtonText = menuCollapsed ? "menu" : "close";
  const animateButtonText = controlValues.isAnimating ? "stop" : "animate";

  const onMenuButtonClick = () => {
    setControlValues((vals) => {
      return { ...vals, menuCollapsed: !vals.menuCollapsed };
    });
  };

  const handleSliderInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { id, value } = event.target;

    const bandHueSpeed = controlValues.bandHueSpeed;
    let isAnimating = controlValues.isAnimating;
    if (
      (id === "hueOffset" && bandHueSpeed != 0) ||
      (id === "bandOffset" && bandHueSpeed != 1)
    ) {
      isAnimating = false;
    }

    setControlValues((vals) => {
      return {
        ...vals,
        isAnimating: isAnimating,
        [id]: parseFloat(value),
      };
    });
  };

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const newIndex =
        (index - 1 + inputRefs.current.length) % inputRefs.current.length;
      inputRefs.current[newIndex]?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const newIndex = (index + 1) % inputRefs.current.length;
      inputRefs.current[newIndex]?.focus();
    }
  };

  return (
    <>
      <button id="menuButton" onClick={onMenuButtonClick}>
        {menuButtonText}
      </button>
      <div id="floatingBox" style={{ visibility, opacity }}>
        <button
          id="animateButton"
          onClick={() =>
            setControlValues((vals) => {
              return {
                ...vals,
                isAnimating: !vals.isAnimating,
              };
            })
          }
        >
          {animateButtonText}
        </button>
        <label key={0}>
          {"animation speed"}: {controlValues.animationSpeed}
          <input
            type="range"
            id="animationSpeed"
            min="1"
            max="10"
            step="0.1"
            value={controlValues.animationSpeed}
            ref={(el) => (inputRefs.current[0] = el)}
            onKeyDown={(e) => handleKeyDown(e, 0)}
            onChange={handleSliderInput}
          />
        </label>
        <label key={1}>
          {"palette scale"}: {controlValues.paletteScale}
          <input
            type="range"
            id="paletteScale"
            min="1"
            max="10"
            step="0.01"
            value={controlValues.paletteScale}
            ref={(el) => (inputRefs.current[1] = el)}
            onKeyDown={(e) => handleKeyDown(e, 1)}
            onChange={handleSliderInput}
          />
        </label>
        <label key={2}>
          {"band spacing"}: {controlValues.bandSpacing}
          <input
            type="range"
            id="bandSpacing"
            min="1"
            max="10"
            step="0.005"
            value={controlValues.bandSpacing}
            ref={(el) => (inputRefs.current[2] = el)}
            onKeyDown={(e) => handleKeyDown(e, 2)}
            onChange={handleSliderInput}
          />
        </label>
        <label key={3}>
          {"band contrast"}: {controlValues.bandContrast}
          <input
            type="range"
            id="bandContrast"
            min="0"
            max="0.5"
            step="0.01"
            value={controlValues.bandContrast}
            ref={(el) => (inputRefs.current[3] = el)}
            onKeyDown={(e) => handleKeyDown(e, 3)}
            onChange={handleSliderInput}
          />
        </label>
        <label
          key={4}
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}
        >
          band offset: {controlValues.bandOffset.toFixed(2)}
          <div style={{ display: "flex", gap: "4px", justifySelf: "end" }}>
            <button
              onClick={() =>
                setControlValues((vals) => {
                  return { ...vals, bandDirection: -1 };
                })
              }
              disabled={controlValues.bandDirection != 1}
            >
              &lt;
            </button>
            <button
              onClick={() =>
                setControlValues((vals) => {
                  return { ...vals, bandDirection: 1 };
                })
              }
              disabled={controlValues.bandDirection != -1}
            >
              &gt;
            </button>
          </div>
          <input
            style={{ gridColumn: "span 2" }}
            type="range"
            id="bandOffset"
            min="-1"
            max="1"
            step="0.01"
            list="zeroMarker"
            value={controlValues.bandOffset}
            ref={(el) => (inputRefs.current[4] = el)}
            onKeyDown={(e) => handleKeyDown(e, 4)}
            onChange={handleSliderInput}
          />
        </label>
        <label key={5}>
          band/hue speed: {controlValues.bandHueSpeed}
          <input
            type="range"
            id="bandHueSpeed"
            min="0"
            max="1"
            step="0.01"
            value={controlValues.bandHueSpeed}
            list="bandHueMarkers"
            ref={(el) => (inputRefs.current[5] = el)}
            onKeyDown={(e) => handleKeyDown(e, 5)}
            onChange={handleSliderInput}
          />
        </label>
        <label
          key={6}
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}
        >
          hue offset: {controlValues.hueOffset.toFixed(0)}
          <div style={{ display: "flex", gap: "4px", justifySelf: "end" }}>
            <button
              onClick={() =>
                setControlValues((vals) => {
                  return { ...vals, hueDirection: -1 };
                })
              }
              disabled={controlValues.hueDirection != 1}
            >
              &lt;
            </button>
            <button
              onClick={() =>
                setControlValues((vals) => {
                  return { ...vals, hueDirection: 1 };
                })
              }
              disabled={controlValues.hueDirection != -1}
            >
              &gt;
            </button>
          </div>
          <input
            style={{ gridColumn: "span 2" }}
            type="range"
            id="hueOffset"
            min="-180"
            max="179"
            step="1"
            list="zeroMarker"
            value={controlValues.hueOffset}
            ref={(el) => (inputRefs.current[6] = el)}
            onKeyDown={(e) => handleKeyDown(e, 6)}
            onChange={handleSliderInput}
          />
        </label>
        <label key={7}>
          saturation: {controlValues.saturation}
          <input
            type="range"
            id="saturation"
            min="0"
            max="2"
            step="0.01"
            value={controlValues.saturation}
            list="oneMarker"
            ref={(el) => (inputRefs.current[7] = el)}
            onKeyDown={(e) => handleKeyDown(e, 7)}
            onChange={handleSliderInput}
          />
        </label>
        <label key={8}>
          lightness: {controlValues.lightness}
          <input
            type="range"
            id="lightness"
            min="0"
            max="2"
            step="0.01"
            value={controlValues.lightness}
            list="oneMarker"
            ref={(el) => (inputRefs.current[8] = el)}
            onKeyDown={(e) => handleKeyDown(e, 8)}
            onChange={handleSliderInput}
          />
        </label>
        <datalist id="zeroMarker">
          <option value="0"></option>
        </datalist>
        <datalist id="oneMarker">
          <option value="1"></option>
        </datalist>
        <datalist id="bandHueMarkers">
          <option value="0"></option>
          <option value="0.25"></option>
          <option value="0.5"></option>
          <option value="0.75"></option>
          <option value="1"></option>
        </datalist>
      </div>
    </>
  );
};
