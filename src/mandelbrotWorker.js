const ITERATIONS = 4096;

const calculateMandelbrotSet = (z, x, y, size) => {
  const is_in_cardioid_or_bulb = (x_pos, y_pos) => {
    let y2 = Math.pow(y_pos, 2);
    let q = Math.pow(x_pos - 0.25, 2) + y2;
    let in_cardioid = q * (q + (x_pos - 0.25)) < 0.25 * y2;
    let in_bulb = Math.pow(x_pos + 1.0, 2) + y2 < 0.0625;
    return in_cardioid || in_bulb;
  };

  const data = new Uint8Array(size * size * 4);

  const scale = Math.pow(2, -z) * 4;
  const offsetX = -2 + x * scale;
  const offsetY = -2 + y * scale;

  for (let pixelX = 0; pixelX < size; pixelX++) {
    for (let pixelY = 0; pixelY < size; pixelY++) {
      let zx = 0;
      let zy = 0;
      let cx = offsetX + (pixelX * scale) / size;
      let cy = offsetY + (pixelY * scale) / size;

      let i = 0;
      if (!is_in_cardioid_or_bulb(cx, cy)) {
        while (zx * zx + zy * zy < 4 && i < ITERATIONS) {
          let temp = zx * zx - zy * zy + cx;
          zy = 2 * zx * zy + cy;
          zx = temp;
          i++;
        }
        i = (i - 1) % (ITERATIONS - 1);
      }

      const brightness = ((i / 100) * 255) | 0;
      let red = (brightness % 8) * 32;
      let green = (brightness % 16) * 16;
      let blue = (brightness % 32) * 8;
      let alpha = 255;

      const index = (pixelY * size + pixelX) * 4;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = alpha;
    }
  }

  return data;
};

onmessage = (e) => {
  const { z, x, y, size } = e.data;
  const mandelbrotData = calculateMandelbrotSet(z, x, y, size);
  postMessage(mandelbrotData);
};
