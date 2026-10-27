import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";
const tests = [
  ...globSync(["test/**/*.test.ts", "src/**/*.test.ts", "../packages/**/*.test.ts"]),
].sort();
if (tests.length === 0) throw new Error("No tests discovered");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
