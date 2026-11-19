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

**Adding a guard:** in the same commit, add it to the list in `docs/dev/convention-guards.md`. `test:lint-rules` picks up any `src/server/services/__tests__/no-*` guard by path prefix; a guard that lives elsewhere must be added to the script in `package.json` by name.

`test:lint-rules` is a convenience selector: the guards match the `unit` project's `include`, so `pnpm run test:unit:run` already runs them, and so does CI's `Unit tests` job, which verifies `main` in scheduled batches rather than per push (on a pull request only when it carries the `full-ci` label).
