import { ExpressionValue } from "ol/style/webgl";

const HUE_SCALE = 360;
const BASE_CONTRAST = 0.42;
const ITER_FALLOFF = 24;
const DITHER_STRENGTH = 0.04;
const SMOOTH_COLOR = true;

const PALETTE_SCALE = 64;
const PALETTE_OFFSET = 0;

const BAND_SPACING = 10;
const BAND_CONTRAST = 0.28;
const BAND_OFFSET = 0;

const SATURATION = 0.8;
const LIGHTNESS = 1;

const unpackUint32 = (): ExpressionValue => {
  const b1 = ["*", ["*", ["band", 1], ["^", 2, 24]], 255];
  const b2 = ["*", ["*", ["band", 2], ["^", 2, 16]], 255];
  const b3 = ["*", ["*", ["band", 3], ["^", 2, 8]], 255];
  const b4 = ["*", ["*", ["band", 4], ["^", 2, 0]], 255];

  return ["+", b1, ["+", b2, ["+", b3, b4]]];
};

export const colorPixelExpression = (): ExpressionValue => {
  const normalizedIters = unpackUint32();

  const adjustedIters = normalizedIters;
  const hue = ["%", adjustedIters, HUE_SCALE];

  const sine = [
    "sin",
    ["/", ["+", normalizedIters, BAND_OFFSET], BAND_SPACING],
  ];
  const sineBand = ["*", BAND_CONTRAST, sine];
  const variance = ["+", BASE_CONTRAST, sineBand];

  const saturation = ["*", variance, SATURATION];
  // const saturation = 0.5;

  const falloff = ["/", ["-", normalizedIters, 1], ITER_FALLOFF];
  const condition = ["<", normalizedIters, ["+", ITER_FALLOFF, 1]];
  const lightness = ["case", condition, ["*", variance, falloff], variance];
  // const lightness = 0.5;

  const blackPixel = ["color", 0, 0, 0, 1];
  return [
    "case",
    ["==", normalizedIters, 0],
    blackPixel,
    hslToRgb(hue, saturation, lightness),
  ];
};

const hslToRgb = (
  hue: ExpressionValue,
  saturation: ExpressionValue,
  lightness: ExpressionValue
): ExpressionValue => {
  const adjLightness = ["-", 1, ["abs", ["-", ["*", 2, lightness], 1]]];
  const c = ["*", adjLightness, saturation];

  const adjHue = ["-", 1, ["abs", ["-", ["%", ["/", hue, 60], 2], 1]]];
  const x = ["*", c, adjHue];

  const m = ["-", lightness, ["/", c, 2]];

  const hueBand = ["floor", ["/", hue, 60]];
  const r = ["match", hueBand, 0, c, 1, x, 2, 0, 3, 0, 4, x, c];
  const g = ["match", hueBand, 0, x, 1, c, 2, c, 3, x, 4, 0, 0];
  const b = ["match", hueBand, 0, 0, 1, 0, 2, x, 3, c, 4, c, x];

  const red = ["round", ["*", ["+", r, m], 255]];
  const green = ["round", ["*", ["+", g, m], 255]];
  const blue = ["round", ["*", ["+", b, m], 255]];

  return ["color", red, green, blue, 1];
};

// const value = ["/", normalizedIters, 2];
// const red = ["*", ["%", value, 8], 32];
// const green = ["*", ["%", value, 16], 16];
// const blue = ["*", ["%", value, 32], 8];

// export const colorPixelExpressionFast: ExpressionValue = [
//   "color",
//   red,
//   green,
//   blue,
//   1,
// ];
