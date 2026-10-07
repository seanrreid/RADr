// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Determinism guardrails (PRD §15, M1 AC4). These APIs are allowed ONLY in the
// modules that own them, so every hash, ordering, and timestamp has one source.
const localeAndHashBans = [
  { selector: "CallExpression[callee.property.name='localeCompare']", message: "localeCompare is locale-dependent. Use stableSort/compareCodePoints from core/determinism." },
  { selector: "MemberExpression[object.name='Intl']", message: "Intl is locale-dependent. Not allowed in radr." },
  { selector: "CallExpression[callee.name='createHash'], CallExpression[callee.property.name='createHash']", message: "Hash only via hash()/hashBytes() in core/determinism." },
];
const jsonStringifyBan = {
  selector: "CallExpression[callee.object.name='JSON'][callee.property.name='stringify']",
  message: "Use canonicalJson() from core/determinism (deterministic key order, no floats).",
};
const clockBans = [
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: "Use the injected Clock (core/clock)." },
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "Use the injected Clock (core/clock)." },
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "test/fixtures/lint/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
      parserOptions: { projectService: { allowDefaultProject: ["eslint.config.js", "bin/*.js"] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "no-restricted-syntax": ["error", ...localeAndHashBans, jsonStringifyBan, ...clockBans],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // node:test describe/it return promises the runner tracks itself.
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["describe", "it", "test", "suite"] }],
      }],
    },
  },
  {
    // The determinism module owns hashing and serialization.
    files: ["src/core/determinism.ts"],
    rules: { "no-restricted-syntax": ["error", ...clockBans] },
  },
  {
    // The clock module owns wall-clock time.
    files: ["src/core/clock.ts"],
    rules: { "no-restricted-syntax": ["error", ...localeAndHashBans, jsonStringifyBan] },
  },
  {
    // Tests and repo scripts may serialize JSON freely (fixtures, reports); the other bans still apply.
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    ignores: ["test/fixtures/lint/**"],
    rules: { "no-restricted-syntax": ["error", ...localeAndHashBans, ...clockBans] },
  },
  { files: ["eslint.config.js", "bin/*.js"], ...tseslint.configs.disableTypeChecked },
);
