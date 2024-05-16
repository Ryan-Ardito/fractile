const PALETTE_SCALE = 64;
const PALETTE_OFFSET = 0;

type HSL = [number, number, number];
type RGB = [number, number, number];

export const colorPixel = (normalizedIters: number): RGB => {
  if (normalizedIters === 0) {
    return [0, 0, 0];
  }

  const hue =
    ((normalizedIters * 360) / (PALETTE_SCALE * Math.log2(normalizedIters)) +
      PALETTE_OFFSET) %
    360;
  const variance = 0.42 + 0.24 * Math.sin(normalizedIters * 0.1);
  const saturation = variance * 0.8;
  const lightness =
    normalizedIters < 24 ? (normalizedIters - 1) / 38 : variance;

  return hslToRgb([hue, saturation, lightness]);
};

const hslToRgb = ([hue, saturation, lightness]: HSL): RGB => {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;

  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 60) {
    red = c;
    green = x;
  } else if (hue < 120) {
    red = x;
    green = c;
  } else if (hue < 180) {
    green = c;
    blue = x;
  } else if (hue < 240) {
    green = x;
    blue = c;
  } else if (hue < 300) {
    red = x;
    blue = c;
  } else {
    red = c;
    blue = x;
  }

  red = Math.round((red + m) * 255);
  green = Math.round((green + m) * 255);
  blue = Math.round((blue + m) * 255);

  return [red, green, blue];
};

export const colorPixelFast = (normalized: number): RGB => {
  const value =
    (normalized / (256 + PALETTE_SCALE * Math.log2(normalized))) * 255;
  const red = (value % 8) * 32;
  const green = (value % 16) * 16;
  const blue = (value % 32) * 8;

  return [red, green, blue];
};
