import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  // Static site: relative base so it deploys under any path (GitHub Pages,
  // a subfolder, or opened from disk) without a rebuild.
  base: "./",
  resolve: {
    alias: {
      // The solver core lives outside web/ and stays dependency-free; the app
      // imports it directly rather than through a published package.
      "@core": fileURLToPath(new URL("../src", import.meta.url)),
      "@data": fileURLToPath(new URL("../data", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
