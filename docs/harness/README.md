# Harness Engineering Framework

This harness adapts the OpenAI harness engineering approach for this LiveKit
interview agent repository. The goal is agent legibility: future agents should
be able to understand the repository, make scoped changes, and get immediate
feedback when they violate project rules.

## Principles

- `AGENTS.md` is a table of contents, not a manual.
- Repository-local docs are the system of record.
- Plans, design history, architecture, and quality rules live in versioned
  files, not chat memory.
- Mechanical checks enforce objective rules.
- Review feedback and repeated mistakes should become docs or tooling.

## Repository Knowledge Layout

```text
AGENTS.md
README.md
docs/
  architecture/
    README.md
  harness/
    README.md
    architecture-invariants.md
    entropy-cleanup.md
    quality-gates.md
  plans/
    active/
    completed/
  superpowers/
    plans/
    specs/
```

`docs/superpowers/` stores skill-generated specs and implementation plans.
`docs/plans/` is the project-level home for active and completed execution
plans that future workers need to discover without knowing which skill created
them.

## Agent Workflow

1. Read `AGENTS.md`, then follow links relevant to the task.
2. Inspect existing code and tests before editing.
3. Write or update a plan for multi-step work.
4. Use test-first development for behavior changes when feasible.
5. Run the focused verification command after each change.
6. Run `pnpm verify` before committing.
7. If a mistake repeats, encode the lesson in docs or tooling.

## Mechanical Check

Run:

```bash
pnpm harness:check
```

The check validates that the harness map, docs, plan directories, README links,
and package scripts are present. Its failure output is written as remediation
guidance for future agents.
