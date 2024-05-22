import { ExpressionValue } from "ol/style/webgl";

const HUE_SCALE = 360;

export const colorPixelExpression = (): ExpressionValue => {
  const iterFalloff = ["var", "iterFalloff"];
  const paletteScale = ["var", "paletteScale"];
  const bandSpacing = ["var", "bandSpacing"];
  const bandContrast = ["var", "bandContrast"];
  const bandOffset = ["var", "bandOffset"];
  const hueOffset = ["var", "hueOffset"];
  const saturation = ["var", "saturation"];
  const lightness = ["var", "lightness"];

  const pixelIters = ["band", 1];

  const hueIters = ["/", pixelIters, paletteScale];
  const pixelHue = ["%", ["+", hueIters, hueOffset], HUE_SCALE];

  const sine = ["sin", ["/", ["+", pixelIters, bandOffset], bandSpacing]];
  const sineBand = ["*", bandContrast, sine];
  const variance = ["+", 0.5, sineBand];

  const pixelSaturation = ["*", variance, saturation];

  const falloff = ["clamp", ["/", ["-", pixelIters, 1], iterFalloff], 0, 1];
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
