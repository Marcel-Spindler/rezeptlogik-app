import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// Node.js globals for plain-JS build/import scripts (not covered by
// typescript-eslint's browser-oriented recommended config, which is why
// process/console/Buffer etc. otherwise show up as "no-undef").
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  fetch: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "functions/**",
      // Vendored IT-handover package, not app code we maintain — linting its
      // bundled/minified scripts produces thousands of meaningless no-undef
      // errors (chrome/MessageChannel/etc. from foreign bundles).
      "Work Order Bot/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-useless-escape": "off"
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
  },
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...nodeGlobals, require: "readonly", module: "readonly", exports: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  }
);
