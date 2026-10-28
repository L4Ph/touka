import { defineConfig, lazyPlugins } from "vite-plus";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";

export default defineConfig(({ mode }) => ({
  defaultPackage: ".",
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins:
    mode === "test"
      ? []
      : lazyPlugins(() => [voidPlugin(), voidReact({ react: { compiler: true } })]),
  test: {
    root: "./server",
    include: [
      "test/**/*.test.ts",
      "src/**/*.test.ts",
      "../packages/**/*.test.ts",
      "auth-test/**/*.test.ts",
      "web-test/**/*.test.ts",
    ],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    pool: "forks",
    maxWorkers: 4,
    testTimeout: 60000,
    hookTimeout: 60000,
    restoreMocks: true,
  },
}));
