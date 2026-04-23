import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/.dev.vars",
      "*.config.*",
      "worker/*.config.*",
      "tsconfig.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // Global CLAUDE.md rule: all `if` statements must use braces.
      curly: ["error", "all"],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // We intentionally swallow close()/send() errors — allow empty catch.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // TS-specific softening: allow `any` as warnings (protocol msg parsing uses it);
      // unused vars starting with _ are OK.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
