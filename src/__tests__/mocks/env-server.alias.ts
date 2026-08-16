/**
 * What `~/env/server` resolves to in the `unit-fast` project — see the `unitFastAlias` block in
 * `vitest.config.mts` for why resolution rather than `vi.mock` is what that project needs.
 *
 * 🔴 It exists as a separate module rather than aliasing straight to `env.mock` because `setup.ts`
 * imports `env` from `./mocks/env.mock` AND calls `vi.mock('~/env/server', …)`. Point the alias at
 * `env.mock` itself and those become the same resolved id, so setup mocks the module it is
 * importing from and every file in the project dies at collection with
 * `Cannot access '__vi_import_4__' before initialization` — 472 of 472, no tests. One indirection
 * keeps the two ids distinct.
 *
 * Only `env` is re-exported, because that is the whole public surface of the real
 * `src/env/server.ts`. Adding to it here would let a test reach for something production cannot.
 */
export { env } from './env.mock';
