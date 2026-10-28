import { fileURLToPath } from "node:url";

// Runtime fixtures resolve build artifacts from the server workspace.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
