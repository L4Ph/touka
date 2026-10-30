import { defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "touka-codemode",
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    // A script may compute for a while; its time is bounded by the caller's timeout.
    limits: { cpuMs: 60_000 },
    exports: {
      CodemodeSandbox: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
