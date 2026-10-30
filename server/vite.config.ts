import { defineConfig, lazyPlugins } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  // In-source tests (`if (import.meta.vitest)`) never reach a deployed Worker.
  define: { "import.meta.vitest": "undefined" },
  plugins: lazyPlugins(() => [cloudflare()]),
});
