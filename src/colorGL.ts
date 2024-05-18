import { ExpressionValue } from "ol/style/webgl";

export const colorPixelExpression = (): ExpressionValue => {
  // unpack normalizedIters from Uint8Array
  const b1 = ["*", ["band", 1], ["^", 2, 24]];
  const b2 = ["*", ["band", 2], ["^", 2, 16]];
  const b3 = ["*", ["band", 3], ["^", 2, 8]];
  const b4 = ["band", 4];
  const normalizedIters = ["floor", ["+", b1, ["+", b2, ["+", b3, b4]]]];

  const value = ["/", normalizedIters, 2];
  const red = ["*", ["%", value, 8], 32];
  const green = ["*", ["%", value, 16], 16];
  const blue = ["*", ["%", value, 32], 8];

  return ["color", red, green, blue, 1];
};

// const PALETTE_SCALE = 64;
// const PALETTE_OFFSET = 0;
// const colorPixelExpression = () => {
//   // unpack Uint32 from Uint8Array bands
//   const normalizedIters = [
//     "floor",
//     ["+", ["*", ["band", 1], ["^", 2, 24]]],
//     ["+", ["*", ["band", 2], ["^", 2, 16]]],
//     ["+", ["*", ["band", 3], ["^", 2, 8]]],
//     ["+", ["band", 4]],
//   ];

//   const colorAdjust = [
//     "+",
//     ["*", PALETTE_SCALE, normalizedIters],
//     PALETTE_OFFSET,
//   ];
//   const hue = ["%", [["*", normalizedIters], 360], []];
//   const variance = ["+", 0.42, ["sin", ["*", 0.1]]];
//   const blackPixel = ["array", 0, 0, 0, 1];

//   return ["array", ["band", 1], ["band", 2], ["band", 3], ["band", 4]];
// };
