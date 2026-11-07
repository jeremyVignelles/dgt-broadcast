import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "/admin/",
  plugins: [vue()],
  build: {
    outDir: "../dist/admin",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: resolve(import.meta.dirname, "services/web/admin/index.html"),
        display: resolve(import.meta.dirname, "services/web/admin/display.html"),
      },
    },
  },
});
