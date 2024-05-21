import { ExpressionValue } from "ol/style/webgl";

const RECIPROCAL_60 = 0.016666666666666666;
const RECIPROCAL_128 = 0.0078125;

const HUE_SCALE = 360;
const BASE_CONTRAST = 0.5;
const ITER_FALLOFF = ["var", "iterFalloff"];

const PALETTE_SCALE = ["var", "paletteScale"];

const BAND_SPACING = ["var", "bandSpacing"];
const BAND_CONTRAST = ["var", "bandContrast"];
const BAND_OFFSET = ["var", "bandOffset"];

const HUE_OFFSET = ["var", "hueOffset"];
const SATURATION = ["var", "saturation"];
const LIGHTNESS = ["var", "lightness"];

const unpackFloat = (): ExpressionValue => {
  // unpack normalizedIters from Uint8Array
  const byte1 = ["*", ["band", 1], 255];
  const byte2 = ["*", ["band", 2], 255];
  const byte3 = ["*", ["band", 3], 255];
  const byte4 = ["*", ["band", 4], 255];

  const signBit = ["floor", ["*", byte4, RECIPROCAL_128]];
  const sign = ["-", 1, ["*", signBit, 2]];

  const exPart1 = ["*", ["%", byte4, 128], 2];
  const exPart2 = ["floor", ["*", byte3, RECIPROCAL_128]];
  const exponent = ["-", ["+", exPart1, exPart2], 127];

  const manPart1 = ["*", ["%", byte3, 128], ["^", 2, -7]];
  const manPart2 = ["*", byte2, ["^", 2, -15]];
  const manPart3 = ["*", byte1, ["^", 2, -23]];
  const mantissa = ["+", 1, ["+", manPart1, ["+", manPart2, manPart3]]];

  return ["*", ["*", sign, mantissa], ["^", 2, exponent]];
};

export const colorPixelExpression = (): ExpressionValue => {
  const normalizedIters = unpackFloat();
  const adjIters = normalizedIters;

  const hueIters = ["/", adjIters, PALETTE_SCALE];
  const hue = ["%", ["+", hueIters, HUE_OFFSET], HUE_SCALE];

  const sine = ["sin", ["/", ["+", adjIters, BAND_OFFSET], BAND_SPACING]];
  const sineBand = ["*", BAND_CONTRAST, sine];
  const variance = ["+", BASE_CONTRAST, sineBand];

  const saturation = ["*", variance, SATURATION];

  const falloff = ["clamp", ["/", ["-", adjIters, 1], ITER_FALLOFF], 0, 1];
  const lightness = ["*", ["*", LIGHTNESS, variance], falloff];

  return hslToRgb(hue, saturation, lightness);
};

const hslToRgb = (
  hue: ExpressionValue,
  saturation: ExpressionValue,
  lightness: ExpressionValue
): ExpressionValue => {
  const adjLightness = ["-", 1, ["abs", ["-", ["*", 2, lightness], 1]]];

  const adjHue = ["*", hue, RECIPROCAL_60];
  const normalizedHue = ["-", 1, ["abs", ["-", ["%", adjHue, 2], 1]]];

  const c = ["*", adjLightness, saturation];
  const x = ["*", c, normalizedHue];

  const hueBand = ["floor", adjHue];
  const r = ["match", hueBand, 0, c, 1, x, 2, 0, 3, 0, 4, x, c];
  const g = ["match", hueBand, 0, x, 1, c, 2, c, 3, x, 4, 0, 0];
  const b = ["match", hueBand, 0, 0, 1, 0, 2, x, 3, c, 4, c, x];

  const m = ["-", lightness, ["*", c, 0.5]];
  const red = ["round", ["*", ["+", r, m], 255]];
  const green = ["round", ["*", ["+", g, m], 255]];
  const blue = ["round", ["*", ["+", b, m], 255]];

  return ["color", red, green, blue, 1];
};
