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
  // hacky black real line fix
  z += 1e-9;

  const isInCardioidOrBulb = (x: number, y: number): boolean => {
    let y2 = y * y;
    let q = (x - 0.25) ** 2 + y2;
    let inCardioid = q * (q + (x - 0.25)) < 0.25 * y2;
    let inBulb = (x + 1.0) ** 2 + y2 < 0.0625;
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

  const scale = 2 ** -z * 4;
  const offsetX = -2 + x * scale;
  const offsetY = -2 + y * scale;

  const data = new Uint8Array(size * size * 4);

  for (let pixelX = 0; pixelX < size; pixelX++) {
    let cx = offsetX + (pixelX * scale) / size;
    for (let pixelY = 0; pixelY < size; pixelY++) {
      let cy = offsetY + (pixelY * scale) / size;

      const index = (pixelY * size + pixelX) * 4;
      if (!isInCardioidOrBulb(cx, cy)) {
        const escapeIters = escapeTime(cx, cy, maxIters);
        const normalizedIters = (escapeIters % maxIters);

        // pack normalizedIters into Uint8Array
        data[index + 0] = normalizedIters & 0xff;
        data[index + 1] = (normalizedIters >> 8) & 0xff;
        data[index + 2] = (normalizedIters >> 16) & 0xff;
        data[index + 3] = (normalizedIters >> 24) & 0xff;
      } else {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
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
