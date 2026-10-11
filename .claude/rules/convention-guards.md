---
paths:
  - "src/server/**"
  - "src/**/*.test.ts"
  - "scripts/**/*.test.ts"
---

# Convention guards

Several repo conventions are enforced by tests in `src/server/services/__tests__/no-*.test.ts`, not by eslint. If one fails, fix the code; don't add an exemption without saying why.

**Read `docs/dev/convention-guards.md` before writing** raw SQL, a transaction, a `vi.mock`, a block bridge or REST route, a money path, or a moderation path: it lists every guard and what it enforces. The ones hit most often:
- `no-bound-make-interval` — inside `$queryRaw`/`Prisma.sql`, inline a `make_interval` argument with `Prisma.raw`; a bound number is int8 and throws 42883.
- `no-io-in-transaction` — no awaited non-database I/O (HTTP, ingestion, queues) inside a `$transaction` callback.
- `no-wholesale-module-mock` — the `importOriginal` rule in `.claude/rules/testing.md`.

**Adding a guard:** in the same commit, add it to the `test:lint-rules` file list in `package.json` (a hand-maintained list, not a glob) and to the list and both counts in `docs/dev/convention-guards.md`. `no-lint-rules-script-drift` fails until all three agree. A green `test:lint-rules` doesn't mean every guard passed unless the script matches the directory.

`test:lint-rules` is a convenience selector: the guards match the `unit` project's `include`, so `pnpm run test:unit:run` and CI's `Unit tests` job already run them.
