// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

const PROJECTS = [
  "./tsconfig.json",
  "./tsconfig.app.json",
  "./tsconfig.node.json",
  "./tsconfig.test.json",
  "./tsconfig.scripts.json",
  "./tsconfig.widget.json",
];

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "eslint.config.js", "public/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "vite.config.ts", "vite.widget.config.ts", "vitest.config.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: { project: PROJECTS, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    languageOptions: {
      parserOptions: { project: PROJECTS, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Deliberately not spreading eslint-plugin-react-hooks's full
      // "recommended" set: v7 bundles React Compiler-oriented rules
      // (purity, immutability, set-state-in-effect, gating, ...) that flag
      // plenty of idiomatic React 18 code as errors. This app targets
      // React 18 without the compiler, so only the two classic, always-
      // applicable hooks rules are enabled.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
