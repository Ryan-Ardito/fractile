import { useRef } from "react";
import { useAppContext } from "../AppContext";

export const Menu = () => {
  const { controlValues, updateControlValues } = useAppContext();
  const menuCollapsed = controlValues.menuCollapsed;

  const visibility = menuCollapsed ? "collapse" : "visible";
  const opacity = menuCollapsed ? "0%" : "100%";
  const menuButtonText = menuCollapsed ? "menu" : "close";
  const animateButtonText = controlValues.isAnimating ? "stop" : "animate";

  const onMenuButtonClick = () => {
    updateControlValues({ type: "TOGGLE_MENU_COLLAPSED" });
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
          onClick={() => updateControlValues({ type: "TOGGLE_ANIMATING" })}
        >
          {animateButtonText}
        </button>
        <label>
          {"animation speed"}: {controlValues.animationSpeed} bpm
          <input
            type="range"
            id="animationSpeed"
            min="1"
            max="256"
            step="1"
            value={controlValues.animationSpeed}
            ref={(el) => (inputRefs.current[0] = el)}
            onKeyDown={(e) => handleKeyDown(e, 0)}
            onChange={(e) => {
              updateControlValues({
                type: "SET_ANIMATION_SPEED",
                payload: parseFloat(e.target.value),
              });
            }}
          />
        </label>
        <label>
          band/hue speed:{" "}
          {(Math.min(1, (1 - controlValues.bandHueSpeed) * 2) * 100).toFixed(0)}
          % / {(Math.min(1, controlValues.bandHueSpeed * 2) * 100).toFixed(0)}%
          <input
            type="range"
            id="bandHueSpeed"
            min="0"
            max="1"
            step="0.005"
            value={controlValues.bandHueSpeed}
            list="bandHueMarkers"
            ref={(el) => (inputRefs.current[5] = el)}
            onKeyDown={(e) => handleKeyDown(e, 5)}
            onChange={(e) =>
              updateControlValues({
                type: "SET_BAND_HUE_SPEED",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </label>
        <label>
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
            onChange={(e) =>
              updateControlValues({
                type: "SET_PALETTE_SCALE",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </label>
        <label>
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
            onChange={(e) =>
              updateControlValues({
                type: "SET_BAND_SPACING",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </label>
        <label>
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
            onChange={(e) =>
              updateControlValues({
                type: "SET_BAND_CONTRAST",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </label>
        <label style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
          band offset: {controlValues.bandOffset.toFixed(2)}
          <div style={{ display: "flex", gap: "4px", justifySelf: "end" }}>
            <button
              onClick={() =>
                updateControlValues({ type: "SET_BAND_DIRECTION", payload: -1 })
              }
              disabled={controlValues.bandDirection != 1}
            >
              &lt;
            </button>
            <button
              onClick={() =>
                updateControlValues({ type: "SET_BAND_DIRECTION", payload: 1 })
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
            min="-3.14"
            max="3.14"
            step="0.01"
            list="zeroMarker"
            value={controlValues.bandOffset}
            ref={(el) => (inputRefs.current[4] = el)}
            onKeyDown={(e) => handleKeyDown(e, 4)}
            onChange={(e) =>
              updateControlValues({
                type: "SET_BAND_OFFSET",
                payload: parseFloat(e.target.value),
              })
            }
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
                updateControlValues({ type: "SET_HUE_DIRECTION", payload: -1 })
              }
              disabled={controlValues.hueDirection != 1}
            >
              &lt;
            </button>
            <button
              onClick={() =>
                updateControlValues({ type: "SET_HUE_DIRECTION", payload: 1 })
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
            onChange={(e) =>
              updateControlValues({
                type: "SET_HUE_OFFSET",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </label>
        <label>
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
            onChange={(e) =>
              updateControlValues({
                type: "SET_SATURATION",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </label>
        <label>
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
            onChange={(e) =>
              updateControlValues({
                type: "SET_LIGHTNESS",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </label>
        <datalist id="zeroMarker">
          <option value="0"></option>
        </datalist>
        <datalist id="oneMarker">
          <option value="1"></option>
        </datalist>
        <datalist id="bandHueMarkers">
          <option value="0.25"></option>
          <option value="0.5"></option>
          <option value="0.75"></option>
        </datalist>
      </div>
    </>
  );
};
