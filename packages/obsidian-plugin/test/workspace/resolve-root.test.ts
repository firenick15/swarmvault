import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceRoot } from "../../src/workspace/resolve-root";

describe("resolveWorkspaceRoot", () => {
  const normalizeMockPath = (value: string) => path.normalize(value);
  const mockExisting = (values: string[]) => new Set(values.map(normalizeMockPath));

  it("returns the override when it contains the marker", () => {
    const existing = mockExisting(["/foo/bar/swarmvault.schema.md"]);
    const result = resolveWorkspaceRoot(undefined, {
      override: "/foo/bar",
      exists: (p) => existing.has(normalizeMockPath(p))
    });
    expect(result).toEqual({ root: "/foo/bar", source: "override" });
  });

  it("returns not-found when override has no marker", () => {
    const result = resolveWorkspaceRoot(undefined, {
      override: "/foo/bar",
      exists: () => false
    });
    expect(result).toEqual({ root: null, source: "not-found" });
  });

  it("walks up from a descendant until marker is found", () => {
    const existing = mockExisting(["/project/swarmvault.schema.md"]);
    const result = resolveWorkspaceRoot("/project/wiki/concepts", {
      exists: (p) => existing.has(normalizeMockPath(p)),
      isDirectory: () => true
    });
    expect(result).toEqual({ root: "/project", source: "marker" });
  });

  it("returns not-found when walking hits the drive root", () => {
    const result = resolveWorkspaceRoot("/some/path/deep", {
      exists: () => false,
      isDirectory: () => true
    });
    expect(result).toEqual({ root: null, source: "not-found" });
  });

  it("respects maxDepth", () => {
    const existing = mockExisting(["/a/swarmvault.schema.md"]);
    const result = resolveWorkspaceRoot("/a/b/c/d/e/f/g/h/i/j/k", {
      exists: (p) => existing.has(normalizeMockPath(p)),
      isDirectory: () => true,
      maxDepth: 2
    });
    expect(result.root).toBeNull();
  });

  it("finds marker at the start directory", () => {
    const existing = mockExisting(["/proj/swarmvault.schema.md"]);
    const result = resolveWorkspaceRoot("/proj", {
      exists: (p) => existing.has(normalizeMockPath(p)),
      isDirectory: () => true
    });
    expect(result.root).toBe("/proj");
  });

  it("finds marker with windows-style paths", () => {
    const root = path.resolve("C:/vault/project");
    const existing = mockExisting([path.join(root, "swarmvault.schema.md")]);
    const result = resolveWorkspaceRoot(path.join(root, "wiki", "concepts"), {
      exists: (p) => existing.has(normalizeMockPath(p)),
      isDirectory: () => true
    });
    expect(result).toEqual({ root, source: "marker" });
  });
});
