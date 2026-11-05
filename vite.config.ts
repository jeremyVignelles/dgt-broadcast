import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "/simulator/",
  plugins: [vue()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist/simulator",
    emptyOutDir: true,
  },
});
