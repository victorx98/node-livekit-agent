# Harness Engineering Framework Design

## Purpose

This repository needs an agent-friendly engineering harness based on OpenAI's
"Harness engineering" article: agents should start from a small map, discover
deeper repository knowledge on demand, and get fast mechanical feedback when
they violate project rules.

The first version is intentionally small and CI-ready. It adds the repo-local
knowledge base, an `AGENTS.md` map, and executable checks that keep the harness
from drifting as the LiveKit interview agent grows.

## Source Principles

The framework encodes five article principles:

- `AGENTS.md` is a table of contents, not an encyclopedia.
- Versioned repository docs are the system of record for architecture, plans,
  quality, and operating rules.
- Architecture and taste are enforced mechanically where possible.
- Agent-readable logs, commands, and remediation messages matter as much as
  prose guidance.
- Entropy is managed continuously through small checks and recurring cleanup,
  not occasional large rewrites.

## Architecture

The harness is a repo-level layer around the existing TypeScript service. It
does not change LiveKit runtime behavior.

- `AGENTS.md` is the short entry point for future agents.
- `docs/harness/` stores the operating framework: workflow, quality gates,
  architecture invariants, and cleanup cadence.
- `docs/architecture/` maps the current service structure and dependency
  boundaries.
- `docs/plans/active/` and `docs/plans/completed/` hold long-running execution
  plans outside chat context.
- `scripts/harness-check.mjs` runs mechanical validation with clear remediation
  output.
- `package.json` exposes `harness:check` and `verify` so humans, agents, and CI
  can run the same checks.

## Mechanical Rules

The initial validator enforces only rules that are cheap, objective, and useful
for future agents:

- `AGENTS.md` exists and stays short enough to be a map.
- Required harness and architecture docs exist.
- Plan directories exist.
- `README.md` links to the harness and architecture docs.
- `package.json` exposes `test`, `typecheck`, `lint`, `harness:check`, and
  `verify`.
- `verify` includes the harness check so doc drift is caught with normal
  project verification.

Each failure includes a contextual remediation message. The validator should
prefer readable JavaScript over clever abstractions because future agents will
modify it.

## Data Flow

The validator reads from the repository root:

1. Load `package.json`.
2. Inspect required file and directory paths.
3. Count `AGENTS.md` lines.
4. Check README cross-links.
5. Check package scripts.
6. Print grouped failures and exit non-zero, or print a success line and exit
   zero.

The validator has no external network dependencies and no LiveKit/OpenAI
credentials.

## Error Handling

All validation failures should be explicit and actionable. Missing files,
missing scripts, overlong agent instructions, and missing README links are
reported as separate failures. Unexpected filesystem or JSON parse errors fail
fast with the underlying error message.

## Testing

The harness validator will be built test-first around a pure validation module.

Planned cases:

- **Happy path**: a minimal fixture with all required docs, scripts, README
  links, and an appropriately short `AGENTS.md` passes.
- **Boundaries**: `AGENTS.md` at the line limit passes; above the line limit
  fails.
- **Invalid input**: missing or malformed `package.json` fails with context.
- **Error paths**: missing required docs, directories, README links, and package
  scripts are reported individually.
- **Domain-specific edges**: `verify` must include `harness:check`, preventing
  agents from adding the harness but leaving it outside normal verification.

## Scope Boundaries

This version does not add GitHub Actions workflow files, custom TypeScript
architecture linting, observability stacks, or PR automation. It creates the
foundation and local check that CI can call. Those larger feedback loops can be
added after the service reaches the next runtime hardening phase.
