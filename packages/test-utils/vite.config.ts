import path from "node:path";
import { defineConfig } from "vite-plus";
import pkg from "./package.json";

const manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} = pkg;

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "tsgo && vp build",
        input: [
          { auto: true },
          { pattern: "!**/*.tsbuildinfo", base: "workspace" },
        ],
        output: ["dist/**", "!dist/*.tsbuildinfo"],
      },
    },
  },
  build: {
    sourcemap: true,
    lib: {
      entry: {
        "blocknote-test-utils": path.resolve(__dirname, "src/index.ts"),
      },
      name: "blocknote-test-utils",
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        format === "es" ? `${entryName}.js` : `${entryName}.cjs`,
    },
    rollupOptions: {
      external: (source) =>
        Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
          ...manifest.devDependencies,
        }).some(
          (dependency) =>
            source === dependency || source.startsWith(`${dependency}/`),
        ) || source.startsWith("node:"),
    },
  },
});
