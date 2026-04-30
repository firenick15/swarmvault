import fs from "node:fs/promises";
import path from "node:path";
import type { CompileOptions } from "./types.js";
import { ensureDir, fileExists, readJsonFile } from "./utils.js";

type LockFile = {
  pid: number;
  createdAt: string;
  rootDir: string;
};

const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const LOCK_POLL_MS = 1000;

function processIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  const lock = await readJsonFile<LockFile>(lockPath).catch(() => null);
  if (!lock) {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
    return true;
  }
  const createdAtMs = Date.parse(lock.createdAt);
  const staleByAge = Number.isFinite(createdAtMs) && Date.now() - createdAtMs > DEFAULT_LOCK_STALE_MS;
  const staleByPid = !processIsAlive(lock.pid);
  if (!staleByAge && !staleByPid) {
    return false;
  }
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
  return true;
}

async function tryAcquireLock(lockPath: string, rootDir: string): Promise<boolean> {
  await ensureDir(path.dirname(lockPath));
  const handle = await fs.open(lockPath, "wx").catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const removed = await removeStaleLock(lockPath);
      if (!removed) {
        return null;
      }
      return fs.open(lockPath, "wx").catch(() => null);
    }
    throw error;
  });
  if (!handle) {
    return false;
  }
  try {
    await handle.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          rootDir
        } satisfies LockFile,
        null,
        2
      ),
      "utf8"
    );
  } finally {
    await handle.close();
  }
  return true;
}

export async function withCompileLock<T>(rootDir: string, options: CompileOptions, run: () => Promise<T>): Promise<T> {
  if (options.lockMode === "skip") {
    return run();
  }
  const lockPath = path.join(rootDir, "state", "compile.lock");
  const timeoutMs = Math.max(1000, options.lifecycleTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const started = Date.now();
  while (!(await tryAcquireLock(lockPath, rootDir))) {
    if (options.lockMode === "fail" || Date.now() - started > timeoutMs) {
      const lock = await readJsonFile<LockFile>(lockPath).catch(() => null);
      const owner = lock ? ` pid=${lock.pid} createdAt=${lock.createdAt}` : "";
      throw new Error(`Another SwarmVault compile is already running for this vault.${owner}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    return await run();
  } finally {
    const lock = await readJsonFile<LockFile>(lockPath).catch(() => null);
    if (!lock || lock.pid === process.pid || !(await fileExists(lockPath))) {
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}
