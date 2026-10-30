import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: ".",
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    root: "./server",
    // Unit tests live in the source files they test (`if (import.meta.vitest)`) and are stripped from
    // builds by `define` in server/vite.config.ts. There are no separate test files.
    includeSource: ["src/**/*.ts", "../packages/*/src/**/*.ts"],
    include: [],
    environment: "node",
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 60000,
    hookTimeout: 60000,
    restoreMocks: true,
  },
});
