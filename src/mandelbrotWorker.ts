const LN_2 = Math.log(2);

const MAP_SCALE = 16;
const MAP_OFFSET = -8;

const BAILOUT = 24;
const PERIODICITY_THRESHOLD = 1e-12;
const CYCLE_DETECTION_DELAY = 40;
const CYCLE_MEMORY_INTERVAL = 20;

const isInCardioidOrBulb = (cx: number, cy: number): boolean => {
  const y2 = cy * cy;
  const q = (cx - 0.25) ** 2 + y2;
  const inCardioid = q * (q + (cx - 0.25)) < 0.25 * y2;
  const inBulb = (cx + 1.0) ** 2 + y2 < 0.0625;
  return inCardioid || inBulb;
};

const escapeTime = (cx: number, cy: number, maxIters: number): number => {
  let zx = 0;
  let zy = 0;
  let x2 = 0;
  let y2 = 0;
  let cycleX = 0;
  let cycleY = 0;

  let i = 0;
  while (i < maxIters) {
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
          return 0;
        }
      }
    }

    cycleX = zx;
    cycleY = zy;
  }

  return 0;
};

const getMandelbrotTile = (
  z: number,
  x: number,
  y: number,
  size: number,
  maxIters: number
): Float32Array => {
  const scale = MAP_SCALE * 2 ** -z;
  const xOffset = x * scale + MAP_OFFSET;
  const yOffset = y * scale + MAP_OFFSET;

  const itersTile = new Float32Array(size * size);

  for (let pixelY = 0; pixelY < size; pixelY++) {
    const cy = (pixelY * scale) / size + yOffset;
    const rowIdx = pixelY * size;
    for (let pixelX = 0; pixelX < size; pixelX++) {
      const cx = (pixelX * scale) / size + xOffset;
      const pixelIdx = rowIdx + pixelX;

      if (isInCardioidOrBulb(cx, cy)) {
        itersTile[pixelIdx] = 0;
        continue;
      }

      itersTile[pixelIdx] = escapeTime(cx, cy, maxIters);
    }
  }

  return itersTile;
};

onmessage = (e) => {
  const { z, x, y, size, iterations } = e.data;
  const mandelbrotData = getMandelbrotTile(z, x, y, size, iterations);
  postMessage(mandelbrotData);
};
