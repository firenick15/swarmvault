import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function executable(command) {
  return process.platform === "win32" && !/\.(cmd|exe|bat)$/i.test(command) ? `${command}.cmd` : command;
}

function run(command, args, cwd) {
  const result = spawnSync(executable(command), args, {
    cwd,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}${detail}`);
  }
}

function runPnpm(args, cwd) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli && /pnpm/i.test(pnpmCli)) {
    const result = spawnSync(process.execPath, [pnpmCli, ...args], {
      cwd,
      stdio: "inherit"
    });
    if (result.status !== 0) {
      const detail = result.error ? `: ${result.error.message}` : "";
      throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}${detail}`);
    }
    return;
  }
  run("pnpm", args, cwd);
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    await cp(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), { recursive: true });
  }
}

const cwd = process.cwd();
const viewerDistIndex = path.resolve(cwd, "../viewer/dist/index.html");
const viewerDistDir = path.resolve(cwd, "../viewer/dist");
const distDir = path.resolve(cwd, "dist");
const viewerTargetDir = path.join(distDir, "viewer");

if (!existsSync(viewerDistIndex)) {
  runPnpm(["--dir", "../viewer", "build"], cwd);
}

runPnpm(["exec", "tsup", "src/index.ts", "src/runtime.ts", "--format", "esm", "--dts"], cwd);
runPnpm(["exec", "tsup", "--config", "tsup.hooks.config.ts"], cwd);

await rm(viewerTargetDir, { recursive: true, force: true });
await copyDirectoryContents(viewerDistDir, viewerTargetDir);
