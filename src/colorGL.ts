import { ExpressionValue } from "ol/style/webgl";

const HUE_SCALE = ["var", "hueScale"];
const BASE_CONTRAST = ["var", "baseContrast"];
const ITER_FALLOFF = ["var", "iterFalloff"];
const DITHER_STRENGTH = ["var", "ditherStrength"];
const SMOOTH_COLOR = ["var", "smoothColor"];

const PALETTE_SCALE = ["var", "paletteScale"];
const PALETTE_OFFSET = ["var", "paletteOffset"];

const BAND_SPACING = ["var", "bandSpacing"];
const BAND_CONTRAST = ["var", "bandContrast"];
const BAND_OFFSET = ["var", "bandOffset"];

const SATURATION = ["var", "saturation"];
const LIGHTNESS = ["var", "lightness"];

const unpackFloat = (): ExpressionValue => {
  // unpack normalizedIters from Uint8Array, big-endian
  const b1 = ["*", ["*", ["band", 1], ["^", 2, 16]], 255];
  const b2 = ["*", ["*", ["band", 2], ["^", 2, 8]], 255];
  const b3 = ["*", ["*", ["band", 3], ["^", 2, 0]], 255];
  // unpack fractional part
  const b4 = ["band", 4];

  return ["+", b1, ["+", b2, ["+", b3, b4]]];
};

// const logBase2 = (num: ExpressionValue): ExpressionValue => {
//   return ["case",
//     ["<", num, 1], 0,
//     ["<", num, 2], 1,
//     ["<", num, 4], 2,
//     ["<", num, 8], 3,
//     ["<", num, 16], 4,
//     ["<", num, 32], 5,
//     ["<", num, 64], 6,
//     ["<", num, 128], 7,
//     ["<", num, 256], 8,
//     ["<", num, 512], 9,
//     ["<", num, 1024], 10,
//     ["<", num, 2048], 11,
//     ["<", num, 4096], 12,
//     ["<", num, 8192], 13,
//     ["<", num, 16384], 14,
//     ["<", num, 32768], 15,
//     ["<", num, 65536], 16,
//     ["<", num, 131072], 17,
//     ["<", num, 262144], 18,
//     ["<", num, 524288], 19,
//     ["<", num, 1048576], 20,
//     ["<", num, 2097152], 21,
//     ["<", num, 4194304], 22,
//     ["<", num, 8388608], 23,
//     24,
//   ];
// }

export const colorPixelExpression = (): ExpressionValue => {
  const normalizedIters = unpackFloat();

  const adjustedIters = normalizedIters;
  const hue = [
    "%",
    ["+", ["/", adjustedIters, PALETTE_SCALE], PALETTE_OFFSET],
    HUE_SCALE,
  ];

  const sine = ["sin", ["/", ["+", adjustedIters, BAND_OFFSET], BAND_SPACING]];
  const sineBand = ["*", BAND_CONTRAST, sine];
  const variance = ["+", BASE_CONTRAST, sineBand];

  const saturation = ["*", variance, SATURATION];

  const falloff = ["/", ["-", adjustedIters, 1], ITER_FALLOFF];
  const condition = ["<", adjustedIters, ["+", ITER_FALLOFF, 1]];
  const lightness = [
    "case",
    condition,
    ["*", ["*", LIGHTNESS, variance], falloff],
    ["*", LIGHTNESS, variance],
  ];

  const blackPixel = ["color", 0, 0, 0, 1];
  return [
    "case",
    ["==", adjustedIters, 0],
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
