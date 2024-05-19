import { ExpressionValue } from "ol/style/webgl";

const HUE_SCALE = 360;
const BASE_CONTRAST = 0.5;
const ITER_FALLOFF = ["var", "iterFalloff"];

const PALETTE_SCALE = ["var", "paletteScale"];
const PALETTE_OFFSET = ["var", "paletteOffset"];

const BAND_SPACING = ["var", "bandSpacing"];
const BAND_CONTRAST = ["var", "bandContrast"];
const BAND_OFFSET = ["var", "bandOffset"];

const SATURATION = ["var", "saturation"];
const LIGHTNESS = ["var", "lightness"];

const unpackFloat = (): ExpressionValue => {
  // unpack normalizedIters from Uint8Array
  const byte1 = ["*", ["band", 1], 255];
  const byte2 = ["*", ["band", 2], 255];
  const byte3 = ["*", ["band", 3], 255];
  const byte4 = ["*", ["band", 4], 255];

  const sign = ["case", [">=", byte4, 128], -1, 1];

  const exponent = [
    "-",
    ["+", ["*", ["%", byte4, 128], 2], ["floor", ["/", byte3, 128]]],
    127,
  ];

  const mantissa = [
    "+",
    1,
    [
      "+",
      ["*", ["%", byte3, 128], ["^", 2, -7]],
      ["+", ["*", byte2, ["^", 2, -15]], ["*", byte1, ["^", 2, -23]]],
    ],
  ];

  return ["*", ["*", sign, mantissa], ["^", 2, exponent]];
};

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
