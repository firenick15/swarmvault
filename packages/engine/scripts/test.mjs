import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitestEntry = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const child = spawn(process.execPath, [vitestEntry, "run", ...process.argv.slice(2)], {
  env: {
    ...process.env,
    SWARMVAULT_ALLOW_PRIVATE_URLS: "1"
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
