import { ExpressionValue } from "ol/style/webgl";

export const colorPixelExpression = (): ExpressionValue => {
  // unpack normalizedIters from Uint8Array
  const b1 = ["*", ["band", 1], ["^", 2, 24]];
  const b2 = ["*", ["band", 2], ["^", 2, 16]];
  const b3 = ["*", ["band", 3], ["^", 2, 8]];
  const b4 = ["band", 4];
  const normalizedIters = ["+", b1, ["+", b2, ["+", b3, b4]]];

  const adjustedIters = ["/", ["*", normalizedIters, 360], 128];
  const hue = ["%", adjustedIters, 360];

  const sine = ["sin", ["*", normalizedIters, 0.1]];
  const sineBand = ["*", 0.24, sine];
  const variance = ["+", 0.42, sineBand];

  const saturation = ["*", variance, 0.8];

  const condition = ["<", normalizedIters, 24];
  const falloff = ["/", ["-", normalizedIters, 1], 38];
  const lightness = ["case", condition, falloff, variance];

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
