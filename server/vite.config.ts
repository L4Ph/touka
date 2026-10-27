import { defineConfig, lazyPlugins } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  plugins: lazyPlugins(() => [cloudflare({ configPath: "./wrangler.jsonc" })]),
});
