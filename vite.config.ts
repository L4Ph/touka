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
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "../packages/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 60000,
    hookTimeout: 60000,
    restoreMocks: true,
  },
});
