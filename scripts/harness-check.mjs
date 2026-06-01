#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateHarnessFiles } from "./harnessRules.mjs";

const root = process.cwd();
const directories = new Set(["docs/plans/active", "docs/plans/completed"]);
const paths = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "docs/harness/README.md",
  "docs/harness/quality-gates.md",
  "docs/harness/architecture-invariants.md",
  "docs/harness/entropy-cleanup.md",
  "docs/architecture/README.md",
  "docs/plans/active",
  "docs/plans/completed",
];

const files = {};

for (const path of paths) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) continue;
  files[path] = directories.has(path) ? null : readFileSync(fullPath, "utf8");
}

const failures = validateHarnessFiles(files);

if (failures.length > 0) {
  console.error("Harness check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Harness check passed.");
}
