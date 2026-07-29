import js from "@eslint/js";
import eslintPluginAstro from "eslint-plugin-astro";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...eslintPluginAstro.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      "scripts/**/*.{js,mjs,cjs,ts}",
      "tests/**/*.{js,mjs,cjs,ts}",
      "src/atproto-publisher.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },
  {
    files: ["src/lexicons/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
