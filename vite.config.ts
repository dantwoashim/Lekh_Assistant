import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const companionBuild = mode === "companion";
  return {
    base: "./",
    plugins: [react()],
    resolve: {
      alias: {
        "@lekh/app-entry": fileURLToPath(new URL(
          companionBuild ? "./src/app/CompanionApp.tsx" : "./src/app/App.tsx",
          import.meta.url
        ))
      }
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "vendor-react";
            if (id.includes("node_modules/lucide-react")) return "vendor-icons";
            if (id.includes("node_modules/nspell") || id.includes("node_modules/dictionary-ne")) return "vendor-hunspell";

            if (id.includes("/src/data/keyboard-packs/")) return "keyboard-runtime-pack";
            if (id.includes("/src/data/aliases/") || id.includes("/src/data/wordlists/") || id.includes("/data/phrases/") || id.includes("/data/lexicon/")) {
              return "keyboard-lexicon-data";
            }

            if (id.includes("/src/engine/keyboard/")) return "engine-keyboard";
            if (id.includes("/src/engine/romanized/") || id.includes("/src/core/transliteration/")) return "engine-romanized";
            if (
              id.includes("/src/engine/proofread/")
              || id.includes("/src/core/dictionary/")
              || id.includes("/src/engine/legacy/")
              || id.includes("/src/core/preeti/")
            ) {
              return "engine-proofing-legacy";
            }
          }
        }
      }
    }
  };
});
