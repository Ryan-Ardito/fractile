import { useState } from "react";

export const Menu = () => {
  const [animationSpeed, setAnimationSpeed] = useState("5");
  const [paletteScale, setPaletteScale] = useState("5");
  const [bandSpacing, setBandSpacing] = useState("3");
  const [bandContrast, setBandContrast] = useState("0.28");
  const [bandOffset, setBandOffset] = useState("0");
  const [bandHueSpeed, setBandHueSpeed] = useState("0.5");
  const [hueOffset, setHueOffset] = useState("0");
  const [saturation, setSaturation] = useState("0.8");
  const [lightness, setLightness] = useState("1");

  return (
    <>
      <button id="menuButton">menu</button>
      <div id="floatingBox">
        <button id="animateButton">animate</button>
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
              setAnimationSpeed(e.target.value);
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
              setPaletteScale(e.target.value);
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
              setBandSpacing(e.target.value);
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
              setBandContrast(e.target.value);
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
              setBandOffset(e.target.value);
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
              setBandHueSpeed(e.target.value);
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
              setHueOffset(e.target.value);
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
              setSaturation(e.target.value);
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
              setLightness(e.target.value);
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
