import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildSearchIndex, searchPages } from "../src/search.js";
import type { GraphPage } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<{ rootDir: string; wikiDir: string; dbPath: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-scope-"));
  tempDirs.push(rootDir);
  const wikiDir = path.join(rootDir, "wiki");
  const dbPath = path.join(rootDir, "state", "retrieval", "fts-000.sqlite");
  await fs.mkdir(path.join(wikiDir, "sources"), { recursive: true });
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  return { rootDir, wikiDir, dbPath };
}

function page(
  id: string,
  title: string,
  _visibility: "public" | "tenant" | "project",
  _tenantId = "",
  projectIds: string[] = []
): GraphPage {
  const now = new Date().toISOString();
  return {
    id,
    path: `sources/${id.replace(/[^a-z0-9]/gi, "-")}.md`,
    title,
    kind: "source",
    sourceIds: [id],
    projectIds,
    nodeIds: [],
    freshness: "fresh",
    status: "active",
    confidence: 1,
    backlinks: [],
    schemaHash: "test",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: now,
    updatedAt: now,
    compiledFrom: [],
    managedBy: "system"
  };
}

async function writePage(wikiDir: string, graphPage: GraphPage, visibility: "public" | "tenant" | "project", tenantId = ""): Promise<void> {
  await fs.writeFile(
    path.join(wikiDir, graphPage.path),
    matter.stringify("scope token shared environmental evidence", {
      title: graphPage.title,
      visibility,
      tenant_id: tenantId
    }),
    "utf8"
  );
}

describe("search scope isolation", () => {
  it("fails closed for tenant/project scopes and keeps mixed scope bounded", async () => {
    const { wikiDir, dbPath } = await workspace();
    const publicPage = page("public", "Public Standard", "public");
    const tenantA = page("tenant-a", "Tenant A Report", "tenant", "a");
    const tenantB = page("tenant-b", "Tenant B Report", "tenant", "b");
    const projectA = page("project-a", "Project A Report", "project", "", ["pa"]);
    for (const [graphPage, visibility, tenantId] of [
      [publicPage, "public", ""],
      [tenantA, "tenant", "a"],
      [tenantB, "tenant", "b"],
      [projectA, "project", ""]
    ] as const) {
      await writePage(wikiDir, graphPage, visibility, tenantId);
    }
    await rebuildSearchIndex(dbPath, [publicPage, tenantA, tenantB, projectA], wikiDir);

    expect(searchPages(dbPath, "shared environmental evidence", { scope: "tenant_only", limit: 5 }).length).toBe(0);
    expect(searchPages(dbPath, "shared environmental evidence", { scope: "project_only", limit: 5 }).length).toBe(0);

    const mixed = searchPages(dbPath, "shared environmental evidence", {
      scope: "mixed_public_private",
      tenantId: "a",
      project: "pa",
      limit: 10
    }).map((result) => result.pageId);
    expect(mixed).toContain("public");
    expect(mixed).toContain("tenant-a");
    expect(mixed).toContain("project-a");
    expect(mixed).not.toContain("tenant-b");
  });
});
