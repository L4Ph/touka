import { defineConfig, lazyPlugins } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  // In-source tests (`if (import.meta.vitest)`) never reach a deployed Worker.
  define: { "import.meta.vitest": "undefined" },
  // Unit tests run in Node; the plugin would start remote proxies for the AI and Browser bindings.
  plugins: lazyPlugins(() => (process.env.VITEST ? [] : [cloudflare()])),
});
