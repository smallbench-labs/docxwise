// Lint config for Obsidian review self-check. Tooling lives in release-audit/lint (TypeScript 5; the build uses TypeScript 7).
import { defineConfig, globalIgnores } from "./release-audit/lint/node_modules/eslint/lib/config-api.js";
import obsidianmd from "./release-audit/lint/node_modules/eslint-plugin-obsidianmd/dist/lib/index.js";
export default defineConfig([
  globalIgnores(["node_modules", "out", "release", "release-audit", ".obsidian-app", "test-vault", "main.js", "esbuild.config.mjs", "eslint.config.mjs", "test/**", "tools/**", "third_party/**", "docs/**"]),
  ...obsidianmd.configs.recommended,
  { languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] }, tsconfigRootDir: import.meta.dirname } } },
]);
