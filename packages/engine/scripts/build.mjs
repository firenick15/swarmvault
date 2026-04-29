import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
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
  run("pnpm", ["--dir", "../viewer", "build"], cwd);
}

run("pnpm", ["exec", "tsup", "src/index.ts", "--format", "esm", "--dts"], cwd);
run("pnpm", ["exec", "tsup", "--config", "tsup.hooks.config.ts"], cwd);

await rm(viewerTargetDir, { recursive: true, force: true });
await copyDirectoryContents(viewerDistDir, viewerTargetDir);
