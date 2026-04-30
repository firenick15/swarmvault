import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { VaultConfig } from "../types.js";
import { fileExists, listFilesRecursive, sha256, toPosix } from "../utils.js";

async function readProfileFile(rootDir: string, relativePath: string | undefined): Promise<Array<{ path: string; hash: string }>> {
  if (!relativePath) {
    return [];
  }
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!(await fileExists(absolutePath))) {
    return [{ path: toPosix(path.relative(rootDir, absolutePath)), hash: "missing" }];
  }
  const content = await fs.readFile(absolutePath, "utf8");
  return [{ path: toPosix(path.relative(rootDir, absolutePath)), hash: sha256(content) }];
}

async function readProfileDirectory(rootDir: string, relativePath: string | undefined): Promise<Array<{ path: string; hash: string }>> {
  if (!relativePath) {
    return [];
  }
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!(await fileExists(absolutePath))) {
    return [{ path: toPosix(path.relative(rootDir, absolutePath)), hash: "missing" }];
  }
  const files = (await listFilesRecursive(absolutePath))
    .filter((filePath) => /\.(md|txt|json|ya?ml)$/i.test(filePath))
    .sort((left, right) => left.localeCompare(right));
  const entries: Array<{ path: string; hash: string }> = [];
  for (const filePath of files) {
    entries.push({
      path: toPosix(path.relative(rootDir, filePath)),
      hash: sha256(await fs.readFile(filePath, "utf8"))
    });
  }
  return entries;
}

function profileReferencePaths(content: string, relativePath: string): string[] {
  let parsed: unknown;
  try {
    parsed = relativePath.endsWith(".json") ? JSON.parse(content) : YAML.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const base = path.posix.dirname(toPosix(relativePath));
  const refs = ["standardCatalog", "terms", "metadataRules", "intentRules", "rankingRules", "topicSeeds", "lintRules", "authorityPolicy"];
  return refs
    .map((key) => (parsed as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => (path.isAbsolute(value) ? value : toPosix(path.posix.join(base, value))));
}

async function readProfileWithReferences(
  rootDir: string,
  relativePath: string | undefined
): Promise<Array<{ path: string; hash: string }>> {
  if (!relativePath) {
    return [];
  }
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!(await fileExists(absolutePath))) {
    return [{ path: toPosix(path.relative(rootDir, absolutePath)), hash: "missing" }];
  }
  const content = await fs.readFile(absolutePath, "utf8");
  const profileEntry = { path: toPosix(path.relative(rootDir, absolutePath)), hash: sha256(content) };
  const referenced: Array<{ path: string; hash: string }> = [];
  for (const refPath of profileReferencePaths(content, profileEntry.path)) {
    const refAbsolutePath = path.isAbsolute(refPath) ? refPath : path.resolve(rootDir, refPath);
    if (!(await fileExists(refAbsolutePath))) {
      referenced.push({ path: toPosix(path.relative(rootDir, refAbsolutePath)), hash: "missing" });
      continue;
    }
    referenced.push({
      path: toPosix(path.relative(rootDir, refAbsolutePath)),
      hash: sha256(await fs.readFile(refAbsolutePath, "utf8"))
    });
  }
  return [profileEntry, ...referenced];
}

export async function domainProfileHash(rootDir: string, config: VaultConfig): Promise<string> {
  const domain = config.domain ?? {};
  const entries = [
    { path: "domain.profileId", hash: sha256(domain.profileId ?? "") },
    ...(await readProfileWithReferences(rootDir, domain.profilePath)),
    ...(await readProfileFile(rootDir, domain.metadataSchemaPath)),
    ...(await readProfileFile(rootDir, domain.termsPath)),
    ...(await readProfileFile(rootDir, domain.rankingPath)),
    ...(await readProfileDirectory(rootDir, domain.promptsDir))
  ].sort((left, right) => left.path.localeCompare(right.path));
  return sha256(JSON.stringify(entries));
}
