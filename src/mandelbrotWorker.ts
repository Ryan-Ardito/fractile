import init, {
  get_mandelbrot_tile,
} from "../mandelbrot-wasm/pkg/mandelbrot_wasm";

onmessage = (e) => {
  init().then(() => {
    const { z, x, y, size, iterations } = e.data;
    const mandelbrotData = get_mandelbrot_tile(z, x, y, size, iterations);
    postMessage(mandelbrotData);
  });
};
