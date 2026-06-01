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
