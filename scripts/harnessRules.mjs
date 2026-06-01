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
