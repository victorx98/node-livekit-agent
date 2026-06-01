# Harness Engineering Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small, CI-ready harness engineering framework that makes this repository legible to future agents and mechanically checks the core harness structure.

**Architecture:** Keep `AGENTS.md` short as the entry map, put durable knowledge in `docs/`, and enforce the first objective rules with a Node.js validator. The validator is split into a pure module for tests and a tiny CLI wrapper for package scripts.

**Tech Stack:** Node.js ESM, TypeScript project conventions, Vitest for test-first validator coverage, existing `pnpm` scripts.

---

## File Structure

- Create `AGENTS.md`: short repository map and agent workflow.
- Create `docs/harness/README.md`: harness operating model and article-derived principles.
- Create `docs/harness/quality-gates.md`: local checks, CI expectations, and review loop.
- Create `docs/harness/architecture-invariants.md`: enforceable project boundaries.
- Create `docs/harness/entropy-cleanup.md`: recurring cleanup cadence.
- Create `docs/architecture/README.md`: current service map derived from the codebase.
- Create `docs/plans/active/.gitkeep` and `docs/plans/completed/.gitkeep`: first-class plan locations.
- Create `scripts/harnessRules.mjs`: pure validation logic.
- Create `scripts/harnessRules.test.mjs`: Vitest tests for validation behavior.
- Create `scripts/harness-check.mjs`: CLI wrapper that exits non-zero on violations.
- Modify `README.md`: link to harness and architecture docs.
- Modify `package.json`: add `harness:check`, `verify`, and include script tests in `test`.
- Modify `vitest.config.ts`: include script-level Vitest tests.

### Task 1: Write Harness Validator Tests

**Files:**

- Create: `scripts/harnessRules.test.mjs`

- [x] **Step 1: Write the failing tests**

```js
import { describe, expect, it } from "vitest";
import { validateHarnessFiles } from "./harnessRules.mjs";

function validFiles(overrides = {}) {
  return {
    "AGENTS.md": "Line 1\nLine 2\n",
    "README.md": "See docs/harness/README.md and docs/architecture/README.md for repo guidance.\n",
    "package.json": JSON.stringify({
      scripts: {
        test: "vitest run",
        typecheck: "tsc -p tsconfig.json --noEmit",
        lint: "eslint . --ext .ts",
        "harness:check": "node scripts/harness-check.mjs",
        verify: "pnpm lint && pnpm typecheck && pnpm test && pnpm harness:check",
      },
    }),
    "docs/harness/README.md": "# Harness\n",
    "docs/harness/quality-gates.md": "# Quality Gates\n",
    "docs/harness/architecture-invariants.md": "# Architecture Invariants\n",
    "docs/harness/entropy-cleanup.md": "# Entropy Cleanup\n",
    "docs/architecture/README.md": "# Architecture\n",
    "docs/plans/active": null,
    "docs/plans/completed": null,
    ...overrides,
  };
}

describe("validateHarnessFiles", () => {
  it("passes when required docs, links, plan directories, and scripts exist", () => {
    expect(validateHarnessFiles(validFiles())).toEqual([]);
  });

  it("allows AGENTS.md at the line limit and rejects it above the limit", () => {
    const atLimit = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(validateHarnessFiles(validFiles({ "AGENTS.md": `${atLimit}\n` }))).toEqual([]);

    const aboveLimit = Array.from({ length: 121 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(validateHarnessFiles(validFiles({ "AGENTS.md": `${aboveLimit}\n` }))).toContain(
      "AGENTS.md is 121 lines; keep it at or below 120 lines so it remains a map.",
    );
  });

  it("reports each missing required document or plan directory", () => {
    const failures = validateHarnessFiles(
      validFiles({
        "docs/harness/README.md": undefined,
        "docs/plans/active": undefined,
      }),
    );

    expect(failures).toContain("Missing required harness path: docs/harness/README.md");
    expect(failures).toContain("Missing required harness path: docs/plans/active");
  });

  it("reports missing README cross-links", () => {
    const failures = validateHarnessFiles(validFiles({ "README.md": "# Service\n" }));

    expect(failures).toContain("README.md must link to docs/harness/README.md.");
    expect(failures).toContain("README.md must link to docs/architecture/README.md.");
  });

  it("reports missing required package scripts and verify integration", () => {
    const failures = validateHarnessFiles(
      validFiles({
        "package.json": JSON.stringify({
          scripts: {
            test: "vitest run",
            typecheck: "tsc -p tsconfig.json --noEmit",
            lint: "eslint . --ext .ts",
            "harness:check": "node scripts/harness-check.mjs",
            verify: "pnpm lint && pnpm typecheck && pnpm test",
          },
        }),
      }),
    );

    expect(failures).toContain("package.json script 'verify' must include harness:check.");
  });

  it("reports malformed package.json with context", () => {
    expect(validateHarnessFiles(validFiles({ "package.json": "not json" }))).toEqual([
      "package.json must be valid JSON.",
    ]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/harnessRules.test.mjs`

Expected: FAIL because `scripts/harnessRules.mjs` does not exist. During
execution, `vitest.config.ts` was first updated to include
`scripts/**/*.test.mjs` so the targeted test was collected.

### Task 2: Implement Pure Harness Validation

**Files:**

- Create: `scripts/harnessRules.mjs`

- [x] **Step 1: Write minimal implementation**

```js
const REQUIRED_PATHS = [
  "AGENTS.md",
  "docs/harness/README.md",
  "docs/harness/quality-gates.md",
  "docs/harness/architecture-invariants.md",
  "docs/harness/entropy-cleanup.md",
  "docs/architecture/README.md",
  "docs/plans/active",
  "docs/plans/completed",
];

const REQUIRED_SCRIPTS = ["test", "typecheck", "lint", "harness:check", "verify"];
const AGENTS_MAX_LINES = 120;

function exists(files, path) {
  return Object.prototype.hasOwnProperty.call(files, path) && files[path] !== undefined;
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
}

export function validateHarnessFiles(files) {
  const failures = [];

  for (const path of REQUIRED_PATHS) {
    if (!exists(files, path)) {
      failures.push(`Missing required harness path: ${path}`);
    }
  }

  if (typeof files["AGENTS.md"] === "string") {
    const lineCount = countLines(files["AGENTS.md"]);
    if (lineCount > AGENTS_MAX_LINES) {
      failures.push(
        `AGENTS.md is ${lineCount} lines; keep it at or below ${AGENTS_MAX_LINES} lines so it remains a map.`,
      );
    }
  }

  if (typeof files["README.md"] === "string") {
    if (!files["README.md"].includes("docs/harness/README.md")) {
      failures.push("README.md must link to docs/harness/README.md.");
    }
    if (!files["README.md"].includes("docs/architecture/README.md")) {
      failures.push("README.md must link to docs/architecture/README.md.");
    }
  } else {
    failures.push("Missing required harness path: README.md");
  }

  let packageJson;
  try {
    packageJson = JSON.parse(files["package.json"]);
  } catch {
    return ["package.json must be valid JSON."];
  }

  const scripts = packageJson.scripts ?? {};
  for (const script of REQUIRED_SCRIPTS) {
    if (typeof scripts[script] !== "string" || scripts[script].trim() === "") {
      failures.push(`package.json must define script '${script}'.`);
    }
  }

  if (typeof scripts.verify === "string" && !scripts.verify.includes("harness:check")) {
    failures.push("package.json script 'verify' must include harness:check.");
  }

  return failures;
}
```

- [x] **Step 2: Run tests to verify green**

Run: `pnpm vitest run scripts/harnessRules.test.mjs`

Expected: PASS for all harness validator tests.

### Task 3: Add CLI Wrapper

**Files:**

- Create: `scripts/harness-check.mjs`

- [x] **Step 1: Implement CLI file loading and failure output**

```js
#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateHarnessFiles } from "./harnessRules.mjs";

const root = process.cwd();
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
  files[path] =
    path === "docs/plans/active" || path === "docs/plans/completed"
      ? null
      : readFileSync(fullPath, "utf8");
}

const failures = validateHarnessFiles(files);
if (failures.length > 0) {
  console.error("Harness check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Harness check passed.");
}
```

- [x] **Step 2: Run CLI before docs exist**

Run: `node scripts/harness-check.mjs`

Expected: FAIL with missing harness docs and scripts.

### Task 4: Add Harness Documentation

**Files:**

- Create: `AGENTS.md`
- Create: `docs/harness/README.md`
- Create: `docs/harness/quality-gates.md`
- Create: `docs/harness/architecture-invariants.md`
- Create: `docs/harness/entropy-cleanup.md`
- Create: `docs/architecture/README.md`
- Create: `docs/plans/active/.gitkeep`
- Create: `docs/plans/completed/.gitkeep`

- [x] **Step 1: Add docs**

Use the approved design as the source of truth. Keep `AGENTS.md` below 120 lines and make every deeper rule discoverable from it.

- [x] **Step 2: Run harness check**

Run: `node scripts/harness-check.mjs`

Expected: FAIL only for missing package scripts and README links.

### Task 5: Wire Package Scripts and README

**Files:**

- Modify: `package.json`
- Modify: `README.md`

- [x] **Step 1: Update scripts**

Set:

```json
{
  "test": "vitest run",
  "harness:check": "node scripts/harness-check.mjs",
  "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm harness:check"
}
```

`vitest.config.ts` includes both `src/**/*.test.ts` and
`scripts/**/*.test.mjs`.

- [x] **Step 2: Update README links**

Add a concise "Harness engineering" section pointing to `AGENTS.md`,
`docs/harness/README.md`, and `docs/architecture/README.md`.

- [x] **Step 3: Run harness check**

Run: `pnpm harness:check`

Expected: PASS with "Harness check passed."

### Task 6: Full Verification

**Files:**

- No new files.

- [x] **Step 1: Run full project verification**

Run: `pnpm verify`

Expected: lint, typecheck, tests, and harness check all pass.

- [x] **Step 2: Review diff**

Run: `git diff --stat && git diff --check`

Expected: no whitespace errors; diff limited to harness docs, scripts, package scripts, and README links.

- [x] **Step 3: Commit**

Run:

```bash
git add AGENTS.md README.md package.json docs scripts
git commit -m "Add agent harness engineering framework"
```

Expected: commit succeeds without bypassing hooks.
