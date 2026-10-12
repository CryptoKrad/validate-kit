import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const typedTsFiles = [
  "apps/**/*.{ts,tsx}",
  "packages/validate-kit/src/**/*.{ts,tsx,mts,cts}",
  "packages/validate-kit/test/**/*.ts",
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/target/**",
      "**/coverage/**",
      "packages/validate-kit/samples/**",
      "packages/validate-kit/rule-tests/**",
      "services/**",
    ],
  },
  // The Next.js, React-hooks and a11y rules for apps/web run in oxlint
  // (.oxlintrc.json overrides): eslint-config-next pulled a `braces` with no
  // fixed release and an eslint-plugin-react that crashes on ESLint 10
  // (docs/research/upgrades-2026-10/next-lint-via-oxlint.md). ESLint keeps the
  // typed rules: typescript-eslint's strictest typed preset, then the kit's own.
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: typedTsFiles,
  })),
  {
    files: typedTsFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // `const { a: _a, ...rest } = x` drops a field on purpose.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_" },
      ],
      // A number prints the same everywhere; an object or undefined does not.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: [
      "*.{ts,mjs}",
      "packages/*/*.config.ts",
      "packages/*/tsup.config.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: false,
      },
      globals: {
        ...globals.node,
      },
    },
  },
  prettier,
);
