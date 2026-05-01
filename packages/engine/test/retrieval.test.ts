import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileVault,
  doctorRetrieval,
  ensureRetrievalReady,
  getRetrievalStatus,
  ingestInput,
  initVault,
  rebuildRetrievalIndex,
  runMigration,
  searchVault
} from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-retrieval-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("retrieval index", () => {
  it("writes retrieval artifacts during compile and searches through the new index path", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "alpha.md"), "# Alpha\n\nDurable retrieval keeps large vault search repairable.\n", "utf8");
    await ingestInput(rootDir, "alpha.md");

    await compileVault(rootDir);

    await expect(fs.access(path.join(rootDir, "state", "retrieval", "fts-000.sqlite"))).resolves.toBeUndefined();
    const manifest = JSON.parse(await fs.readFile(path.join(rootDir, "state", "retrieval", "manifest.json"), "utf8"));
    expect(manifest.backend).toBe("sqlite");
    expect(manifest.indexSchemaVersion).toBeGreaterThanOrEqual(3);
    expect(manifest.indexSchemaHash).toBeTruthy();
    expect(manifest.shards[0].path).toBe("retrieval/fts-000.sqlite");

    const status = await getRetrievalStatus(rootDir);
    expect(status.stale).toBe(false);
    expect(status.schemaOk).toBe(true);
    expect(status.indexExists).toBe(true);
    expect(status.manifestExists).toBe(true);

    const results = await searchVault(rootDir, "repairable retrieval", 5);
    expect(results.some((result) => result.title.includes("Alpha"))).toBe(true);
  });

  it("repairs missing retrieval artifacts", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "alpha.md"), "# Alpha\n\nRetrieval doctor rebuilds missing local indexes.\n", "utf8");
    await ingestInput(rootDir, "alpha.md");
    await compileVault(rootDir);
    await fs.rm(path.join(rootDir, "state", "retrieval", "fts-000.sqlite"), { force: true });

    const before = await doctorRetrieval(rootDir);
    expect(before.ok).toBe(false);
    expect(before.actions).toEqual(["rebuild"]);

    const repaired = await doctorRetrieval(rootDir, { repair: true });
    expect(repaired.repaired).toBe(true);
    expect(repaired.status.indexExists).toBe(true);

    const rebuilt = await rebuildRetrievalIndex(rootDir);
    expect(rebuilt.stale).toBe(false);
  });

  it("repairs stale retrieval artifacts before query use", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "alpha.md"), "# Alpha\n\nRetrieval readiness repairs stale manifests.\n", "utf8");
    await ingestInput(rootDir, "alpha.md");
    await compileVault(rootDir);
    const manifestPath = path.join(rootDir, "state", "retrieval", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.graphHash = "stale";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const ready = await ensureRetrievalReady(rootDir, { policy: "auto_repair" });
    expect(ready.staleBeforeQuery).toBe(true);
    expect(ready.repaired).toBe(true);
    expect(ready.status.stale).toBe(false);
  });

  it("migrates legacy search config and removes state/search.sqlite", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const configPath = path.join(rootDir, "swarmvault.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.search = { hybrid: false, rerank: true };
    delete config.retrieval;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(rootDir, "state", "search.sqlite"), "legacy", "utf8");

    const result = await runMigration(rootDir, { targetVersion: "3.0.0", dryRun: false });
    const seen = new Set([...result.applied.map((entry) => entry.id), ...result.skipped.map((entry) => entry.id)]);
    expect(seen.has("2.0-to-3.0-retrieval-and-task-surface")).toBe(true);

    const migrated = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(migrated.search).toBeUndefined();
    expect(migrated.retrieval).toMatchObject({ backend: "sqlite", hybrid: false, rerank: true });
    await expect(fs.access(path.join(rootDir, "state", "search.sqlite"))).rejects.toThrow();
    await expect(fs.access(path.join(rootDir, "state", "retrieval"))).resolves.toBeUndefined();
  });
});
