const ALPHA = 255;

const PERIODICITY_THRESHOLD = 1e-9;
const CYCLE_DETECTION_DELAY = 40;
const PALETTE_SCALE = 200;

const calculateMandelbrotSet = (
  z: number,
  x: number,
  y: number,
  size: number,
  iterations: number
): Uint8Array => {
  // hacky black real line fix
  z += PERIODICITY_THRESHOLD;

  const isInCardioidOrBulb = (x: number, y: number): boolean => {
    let y2 = y * y;
    let q = Math.pow(x - 0.25, 2) + y2;
    let inCardioid = q * (q + (x - 0.25)) < 0.25 * y2;
    let inBulb = Math.pow(x + 1.0, 2) + y2 < 0.0625;
    return inCardioid || inBulb;
  };

  const escapeTime = (
    cx: number,
    cy: number,
    maxIterations: number
  ): number => {
    let zx = 0;
    let zy = 0;
    let x2 = 0;
    let y2 = 0;
    let cycleX = 0;
    let cycleY = 0;

    let i = 0;
    while (i < maxIterations) {
      for (let s = 0; s < 20; s++) {
        if (x2 + y2 > 4) {
          return i;
        }

        zy = (zx + zx) * zy + cy;
        zx = x2 - y2 + cx;
        x2 = zx * zx;
        y2 = zy * zy;
        i++;

        if (i >= CYCLE_DETECTION_DELAY) {
          if (
            Math.abs(zx - cycleX) < PERIODICITY_THRESHOLD &&
            Math.abs(zy - cycleY) < PERIODICITY_THRESHOLD
          ) {
            return maxIterations;
          }
        }
      }

      cycleX = zx;
      cycleY = zy;
    }

    return maxIterations;
  };

  const colorPixel = (normalized: number) => {
    const value =
      (normalized / (256 + PALETTE_SCALE * Math.log2(normalized))) * 255;
    let red = (value % 8) * 32;
    let green = (value % 16) * 16;
    let blue = (value % 32) * 8;

    return [red, green, blue];
  };

  const scale = Math.pow(2, -z) * 4;
  const offsetX = -2 + x * scale;
  const offsetY = -2 + y * scale;

  const data = new Uint8Array(size * size * 4);

  for (let pixelX = 0; pixelX < size; pixelX++) {
    let cx = offsetX + (pixelX * scale) / size;
    for (let pixelY = 0; pixelY < size; pixelY++) {
      let cy = offsetY + (pixelY * scale) / size;

      const index = (pixelY * size + pixelX) * 4;
      if (!isInCardioidOrBulb(cx, cy)) {
        const escape = escapeTime(cx, cy, iterations);

        const normalized = escape % iterations;
        const [red, green, blue] = colorPixel(normalized);

        data[index] = red;
        data[index + 1] = green;
        data[index + 2] = blue;
        data[index + 3] = ALPHA;
      } else {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = ALPHA;
      }
    }
  }

  return data;
};

onmessage = (e) => {
  const { z, x, y, size, iterations } = e.data;
  const mandelbrotData = calculateMandelbrotSet(z, x, y, size, iterations);
  postMessage(mandelbrotData);
};
