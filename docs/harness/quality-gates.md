# Quality Gates

Quality gates are the checks a human or agent must run before claiming work is
complete. They are intentionally local and credential-free.

## Default Verification

Run:

```bash
pnpm verify
```

`pnpm verify` runs linting, TypeScript typechecking, unit tests, and the harness
check. Use it before implementation commits.

## Focused Checks

- `pnpm lint`: style and static lint rules.
- `pnpm typecheck`: TypeScript compilation without emitting output.
- `pnpm test`: Vitest test suite.
- `pnpm harness:check`: repository harness structure and cross-links.
- `pnpm build`: production compilation to `dist/`.

Use focused checks during development, then use `pnpm verify` before commit.

## Review Loop

For non-trivial changes:

1. Identify the behavior or invariant being changed.
2. Add or update a focused test before production code when feasible.
3. Verify the test fails for the missing behavior.
4. Implement the smallest change that makes it pass.
5. Re-run the focused test.
6. Run `pnpm verify`.
7. Review the diff for unrelated churn.

## Completion Standard

A task is complete only when:

- The requested behavior or documentation exists.
- Relevant tests pass.
- `pnpm verify` passes, or any skipped command is explicitly explained.
- The diff is scoped to the task.
- New operating knowledge is captured in docs when it affects future agents.
