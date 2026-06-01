# Entropy Cleanup

Agent-generated repositories drift when uneven patterns are copied. Cleanup is
part of the harness, not an occasional rescue project.

## Cadence

Run a cleanup pass after each phase milestone and before broad feature work.
For this service, phase milestones are the README status phases.

## Cleanup Checklist

- Run `pnpm verify`.
- Read `AGENTS.md` and confirm it is still a map, not a manual.
- Check `docs/architecture/README.md` against the current `src/` layout.
- Move stale active plans from `docs/plans/active/` to `docs/plans/completed/`.
- Remove duplicated helper logic when a shared utility already exists.
- Convert repeated review feedback into docs or harness checks.
- Delete obsolete docs instead of preserving contradictory guidance.

## Golden Principles

- Validate data at system boundaries.
- Keep pure modules pure.
- Keep runtime orchestration thin.
- Prefer small focused files with explicit dependencies.
- Make failures visible through tests, logs, or harness checks.

## Escalation

When cleanup uncovers a behavior risk, add a focused test before refactoring.
When cleanup uncovers only documentation drift, update the docs and run
`pnpm harness:check`.
