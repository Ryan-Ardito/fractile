import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasmPack from 'vite-plugin-wasm-pack'

export default defineConfig(async () => ({
  plugins: [react(), wasmPack(['./mandelbrot-wasm'])],

  build: {
    sourcemap: true,
  },
}));
