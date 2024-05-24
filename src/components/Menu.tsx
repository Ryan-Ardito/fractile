import { useRef, useState } from "react";
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

  const controlInputs = [
    {
      id: "animationSpeed",
      label: "animation speed",
      min: 1,
      max: 10,
      step: 0.1,
      value: controlValues.animationSpeed,
    },
    {
      id: "paletteScale",
      label: "palette scale",
      min: 1,
      max: 10,
      step: 0.01,
      value: controlValues.paletteScale,
    },
    {
      id: "bandSpacing",
      label: "band spacing",
      min: 1,
      max: 10,
      step: 0.005,
      value: controlValues.bandSpacing,
    },
    {
      id: "bandContrast",
      label: "band contrast",
      min: 0,
      max: 0.5,
      step: 0.01,
      value: controlValues.bandContrast,
    },
    {
      id: "bandOffset",
      label: "band offset",
      min: -1,
      max: 1,
      step: 0.01,
      value: controlValues.bandOffset,
    },
    {
      id: "bandHueSpeed",
      label: "band/hue speed",
      min: 0,
      max: 1,
      step: 0.01,
      value: controlValues.bandHueSpeed,
      list: "bandHueMarkers",
    },
    {
      id: "hueOffset",
      label: "hue offset",
      min: -180,
      max: 179,
      step: 1,
      value: controlValues.hueOffset,
    },
    {
      id: "saturation",
      label: "saturation",
      min: 0,
      max: 2,
      step: 0.01,
      value: controlValues.saturation,
      list: "oneMarker",
    },
    {
      id: "lightness",
      label: "lightness",
      min: 0,
      max: 2,
      step: 0.01,
      value: controlValues.lightness,
      list: "oneMarker",
    },
  ];

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
        {controlInputs.map((inputRange, index) => (
          <label key={index}>
            {inputRange.label}: {inputRange.value}
            <input
              type="range"
              id={inputRange.id}
              min={inputRange.min}
              max={inputRange.max}
              step={inputRange.step}
              value={inputRange.value}
              list={inputRange.list}
              ref={(el) => (inputRefs.current[index] = el)}
              onChange={handleSliderChange}
              onKeyDown={(e) => handleKeyDown(e, index)}
            />
          </label>
        ))}
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
