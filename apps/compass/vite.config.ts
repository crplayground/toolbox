import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

// ビルド結果は単一の index.html としてリポジトリ直下の compass/ に書き出す。
// GitHub Pages はリポジトリ全体をそのまま配信するため、ビルド済みHTMLをコミットして公開する。
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  build: {
    outDir: path.resolve(import.meta.dirname, "../../compass"),
    emptyOutDir: false,
  },
  server: { port: 5173 },
});
