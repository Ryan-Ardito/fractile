import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],

  base: "/fractile/",
  build: {
    sourcemap: true,
  },
}));
