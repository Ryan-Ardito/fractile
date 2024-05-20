const LN_2 = 0.6931471805599453;

const BAILOUT = 24;
const PERIODICITY_THRESHOLD = 1e-12;
const CYCLE_DETECTION_DELAY = 40;
const CYCLE_MEMORY_INTERVAL = 20;

const calculateMandelbrotSet = (
  z: number,
  x: number,
  y: number,
  size: number,
  maxIters: number
): Uint8Array => {
  const isInCardioidOrBulb = (x: number, y: number): boolean => {
    const y2 = y * y;
    const q = (x - 0.25) ** 2 + y2;
    const inCardioid = q * (q + (x - 0.25)) < 0.25 * y2;
    const inBulb = (x + 1.0) ** 2 + y2 < 0.0625;
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
      for (let s = 0; s < CYCLE_MEMORY_INTERVAL; s++) {
        if (x2 + y2 > BAILOUT) {
          return i + 2 - Math.log(Math.log(x2 + y2)) / LN_2;
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

  const scale = 2 ** -z * 16;
  const offsetX = -8 + x * scale;
  const offsetY = -8 + y * scale;

  const buffer = new ArrayBuffer(size * size * 4);
  const view = new DataView(buffer);
  const data = new Uint8Array(buffer);

  for (let pixelX = 0; pixelX < size; pixelX++) {
    let cx = offsetX + (pixelX * scale) / size;
    for (let pixelY = 0; pixelY < size; pixelY++) {
      let cy = offsetY + (pixelY * scale) / size;

      const index = (pixelY * size + pixelX) * 4;
      if (!isInCardioidOrBulb(cx, cy)) {
        const escapeIters = escapeTime(cx, cy, maxIters);
        let normalizedIters = escapeIters;
        if (escapeIters === maxIters) {
          normalizedIters = 0;
        }

        // pack normalizedIters into Uint8Array
        view.setFloat32(index, normalizedIters, true);
      } else {
        view.setFloat32(index, 0, true);
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
