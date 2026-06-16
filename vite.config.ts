import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const libraryEntry = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: libraryEntry,
      formats: ["es"],
      fileName: "reed",
    },
    sourcemap: true,
  },
});
