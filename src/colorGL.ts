import { ExpressionValue } from "ol/style/webgl";

const unpackFloat = (): ExpressionValue => {
  // unpack normalizedIters from Uint8Array
  const byte1 = ["*", ["band", 1], 255];
  const byte2 = ["*", ["band", 2], 255];
  const byte3 = ["*", ["band", 3], 255];
  const byte4 = ["*", ["band", 4], 255];

  const signBit = ["floor", ["*", byte4, 1 / 128]];
  const sign = ["-", 1, ["*", signBit, 2]];

  const exPart1 = ["*", ["%", byte4, 128], 2];
  const exPart2 = ["floor", ["*", byte3, 1 / 128]];
  const exponent = ["-", ["+", exPart1, exPart2], 127];

  const manPart1 = ["*", ["%", byte3, 128], ["^", 2, -7]];
  const manPart2 = ["*", byte2, ["^", 2, -15]];
  const manPart3 = ["*", byte1, ["^", 2, -23]];
  const mantissa = ["+", 1, ["+", manPart1, ["+", manPart2, manPart3]]];

  return ["*", ["*", sign, mantissa], ["^", 2, exponent]];
};

export const colorPixelExpression = (): ExpressionValue => {
  const hueScale = 360;
  const baseContrast = 0.5;
  const iterFalloff = ["var", "iterFalloff"];
  const paletteScale = ["var", "paletteScale"];
  const bandSpacing = ["var", "bandSpacing"];
  const bandContrast = ["var", "bandContrast"];
  const bandOffset = ["var", "bandOffset"];
  const hueOffset = ["var", "hueOffset"];
  const saturation = ["var", "saturation"];
  const lightness = ["var", "lightness"];

  const normalizedIters = unpackFloat();
  const adjIters = normalizedIters;

  const hueIters = ["/", adjIters, paletteScale];
  const pixelHue = ["%", ["+", hueIters, hueOffset], hueScale];

  const sine = ["sin", ["/", ["+", adjIters, bandOffset], bandSpacing]];
  const sineBand = ["*", bandContrast, sine];
  const variance = ["+", baseContrast, sineBand];

  const pixelSaturation = ["*", variance, saturation];

  const falloff = ["clamp", ["/", ["-", adjIters, 1], iterFalloff], 0, 1];
  const pixelLightness = ["*", ["*", lightness, variance], falloff];

  return hslToRgb(pixelHue, pixelSaturation, pixelLightness);
};

const hslToRgb = (
  hue: ExpressionValue,
  saturation: ExpressionValue,
  lightness: ExpressionValue
): ExpressionValue => {
  const adjLightness = ["-", 1, ["abs", ["-", ["*", 2, lightness], 1]]];

  const adjHue = ["*", hue, 1 / 60];
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
