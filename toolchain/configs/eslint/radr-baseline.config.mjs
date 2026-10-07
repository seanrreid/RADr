// radr baseline ESLint config (lint lane, baseline mode). Copied next to the pinned
// node-tools install so its imports resolve there. Syntax-only: no type information, no client
// plugins, so results are comparable across engagements. Its content hash is in toolchain.lock.
//
// Severity: 2 (error) = correctness/security smell; 1 (warn) = maintainability/style.
import tsParser from "@typescript-eslint/parser";

const rules = {
  "no-eval": 2, "no-implied-eval": 2, "no-new-func": 2, "no-script-url": 2, "no-proto": 2, "no-caller": 2, "no-with": 2,
  "no-debugger": 2, "no-dupe-keys": 2, "no-dupe-args": 2, "no-duplicate-case": 2, "no-unreachable": 2, "no-unsafe-finally": 2,
  "no-unsafe-negation": 2, "no-self-assign": 2, "no-self-compare": 2, "no-cond-assign": 2, "no-fallthrough": 2,
  "no-sparse-arrays": 2, "no-constant-binary-expression": 2, "use-isnan": 2, "valid-typeof": 2,
  "eqeqeq": 1, "no-var": 1, "no-empty": 1, "no-useless-catch": 1, "no-constant-condition": 1, "no-unused-vars": 1,
  "prefer-const": 1, "no-param-reassign": 1,
};

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/vendor/**", "**/*.min.js", "**/coverage/**"] },
  { files: ["**/*.{js,jsx,mjs,cjs}"], languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } }, rules },
  { files: ["**/*.{ts,tsx,mts,cts}"], languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } }, rules },
];
