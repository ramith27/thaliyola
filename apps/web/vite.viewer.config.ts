import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The static site export: a self-contained viewer with relative paths, so it works from any folder (GitHub Pages, MkDocs, a file share).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist-viewer", emptyOutDir: true, rollupOptions: { input: "viewer.html" } },
});
