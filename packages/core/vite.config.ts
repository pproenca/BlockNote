import * as path from "path";
import { webpackStats } from "rollup-plugin-webpack-stats";
import { defineConfig } from "vite-plus";
import pkg from "./package.json";
// import eslintPlugin from "vite-plugin-eslint";

// https://vitejs.dev/config/
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitestSetup.ts"],
    server: {
      deps: {
        inline: ["@y/prosemirror"],
      },
    },
  },
  plugins: [webpackStats()],
  build: {
    sourcemap: true,
    lib: {
      entry: {
        blocknote: path.resolve(__dirname, "src/index.ts"),
        comments: path.resolve(__dirname, "src/comments/index.ts"),
        "comments-internal": path.resolve(
          __dirname,
          "src/comments/internal.ts",
        ),
        "detect-markdown": path.resolve(
          __dirname,
          "src/api/parsers/markdown/detectMarkdown.ts",
        ),
        blocks: path.resolve(__dirname, "src/blocks/index.ts"),
        locales: path.resolve(__dirname, "src/i18n/index.ts"),
        extensions: path.resolve(__dirname, "src/extensions/index.ts"),
        persistence: path.resolve(__dirname, "src/persistence/index.ts"),
        "persistence-internal": path.resolve(
          __dirname,
          "src/persistence/internal.ts",
        ),
        runtime: path.resolve(__dirname, "src/runtime/index.ts"),
        yjs: path.resolve(__dirname, "src/yjs/index.ts"),
        y: path.resolve(__dirname, "src/y/index.ts"),
      },
      name: "blocknote",
      cssFileName: "style",
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        format === "es" ? `${entryName}.js` : `${entryName}.cjs`,
    },
    rollupOptions: {
      // make sure to externalize deps that shouldn't be bundled
      // into your library
      external: (source) => {
        // This package is patched in the fork. Bundle the patched runtime so
        // published BlockNote packages never depend on a consumer-side patch.
        if (
          source === "@y/prosemirror" ||
          source.startsWith("@y/prosemirror/") ||
          source === "@handlewithcare/prosemirror-inputrules" ||
          source.startsWith("@handlewithcare/prosemirror-inputrules/") ||
          source === "prosemirror-history"
        ) {
          return false;
        }

        if (
          Object.keys({
            ...pkg.dependencies,
            ...((pkg as any).peerDependencies || {}),
            ...pkg.devDependencies,
          }).some((dep) => source === dep || source.startsWith(dep + "/"))
        ) {
          return true;
        }
        return (
          source.startsWith("react/") ||
          source.startsWith("react-dom/") ||
          source.startsWith("prosemirror-") ||
          source.startsWith("@tiptap/") ||
          source.startsWith("@blocknote/") ||
          source.startsWith("@shikijs/") ||
          source.startsWith("node:")
        );
      },
      output: {
        // Provide global variables to use in the UMD build
        // for externalized deps
        globals: {},
      },
    },
  },
});
