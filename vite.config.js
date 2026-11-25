import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const reclaim = path.resolve(here, "../../reclaim-ui");

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@reclaim/ui": path.join(reclaim, "packages/ui/src"),
      "@reclaim/themes": path.join(reclaim, "themes"),
      "@": path.resolve(here, "src"),
    },
  },
  server: { fs: { allow: [here, reclaim] } },
  base: "./",
});
