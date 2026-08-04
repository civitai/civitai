/**
 * Shared `vi.mock` factory for `~/server/db/pgDb`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/server/db/kyselyDb.ts` does `import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb'`
 * and builds a Kysely client per tier at module-eval time. Vitest's mocked-module proxy THROWS on any
 * named export the factory did not return:
 *
 *     Error: [vitest] No "pgDbReadLong" export is defined on the "~/server/db/pgDb" mock.
 *
 * That throw happens during module LOAD, so it becomes the rejection value every assertion in the suite
 * then inspects — the failures read as assertion failures against intact production code, and a suite
 * whose collection dies reports *no* failures at all, it just silently stops contributing tests.
 *
 * Historically each suite hand-wrote its own factory listing only the exports it happened to need, so
 * adding an export to pgDb (or making kyselyDb newly reachable from some suite's import graph) reddened
 * an arbitrary subset of unrelated suites. That happened at least twice.
 *
 * THE GUARANTEE
 * -------------
 * `stubs` below is typed `Record<PgDbExportName, unknown>`, where `PgDbExportName = keyof typeof import(pgDb)`.
 * That is a TOTAL record: if `pgDb` gains an export and this object does not, `tsc` fails and NAMES the
 * missing export. The `Typecheck` CI job is a blocking gate (unlike `Unit tests`, which is
 * `continue-on-error: true`), so this is caught before merge, in one file, with one legible message —
 * instead of N obscure suite failures nobody attributes to the right cause.
 *
 * `src/test-utils/__tests__/pgDbMock.parity.test.ts` re-asserts the same invariant at runtime against the
 * real module's actual export list, and asserts that no suite hand-rolls its own factory again.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not auto-stub unknown exports (e.g. via a `Proxy`), and it does not fall through to the real
 * module via `importOriginal()` / `importActual()`. Both would "fix" the breakage class by making the
 * mock permissive, and both trade a loud failure for a silent wrong one:
 *   - a blanket auto-stub makes an unmocked DB call return `undefined` instead of failing, so a test can
 *     pass that should have failed;
 *   - falling through to the real module evaluates `pgDb`, which calls `getClient()` and constructs real
 *     `pg` pools from real env in a unit test.
 * Enumerating explicitly, and letting the compiler force the enumeration to stay exhaustive, keeps the
 * failure loud and keeps unit tests off the database.
 *
 * USAGE — the factory is hoisted above imports, so pull the helper in with a dynamic import:
 *
 *     vi.mock('~/server/db/pgDb', async () => {
 *       const { createPgDbMock } = await import('~/test-utils/pgDbMock');
 *       return createPgDbMock();
 *     });
 *
 * ...and pass overrides for whichever pool the suite actually drives (`vi.hoisted` values are in scope):
 *
 *     vi.mock('~/server/db/pgDb', async () => {
 *       const { createPgDbMock } = await import('~/test-utils/pgDbMock');
 *       return createPgDbMock({ pgDbWrite: { query: mockQuery } });
 *     });
 */
import type * as PgDb from '~/server/db/pgDb';

type PgDbModule = typeof PgDb;

/** Union of every name `~/server/db/pgDb` exports. Grows automatically with the real module. */
export type PgDbExportName = keyof PgDbModule;

/**
 * Total map over the real module's export names. Making this `Record<...>` rather than `Partial<...>` is
 * the whole point: it is what turns "someone added an export to pgDb" into a compile error here.
 */
type PgDbStubs = Record<PgDbExportName, unknown>;

/**
 * The canonical complete mock namespace for `~/server/db/pgDb`.
 *
 * 🔴 Test suites do NOT call this at runtime — they keep their own inline SYNC object literal, and
 * `pgDbMock.parity.test.ts` scans them to confirm the key set matches. Sharing this factory would force
 * every mocked suite into `vi.mock('...', async () => await import(...))`, because a mock factory is
 * hoisted above imports and cannot reach a statically imported helper. The inline literal is kept to avoid
 * that async indirection in 17 files, not for performance: an earlier revision of this comment claimed the
 * async form cost +36%/+64% in CI, and that claim is RETRACTED — it compared two runs on different pods
 * without normalising for ambient speed. Normalised, the async and sync runs are indistinguishable (global
 * median 1.43x vs base, target file 1.36x, identical in both).
 *
 * Its job is to be the ONE typed declaration of the full export set: `PgDbStubs` is a total `Record` over
 * the real module's names, so adding an export to pgDb fails `tsc` right here, naming it. `overrides` is
 * keyed to the real export names, so a typo (`pgDbWirte`) is a compile error too.
 */
export function createPgDbMock(overrides: Partial<PgDbStubs> = {}): PgDbModule {
  const stubs: PgDbStubs = {
    pgDbRead: {},
    pgDbReadLong: {},
    pgDbWrite: {},
  };

  // The stubs are intentionally not real `AugmentedPool`s; the cast is what lets a `{}` stand in for one.
  // Completeness of the KEY SET — the thing that actually breaks suites — is enforced above, not here.
  return { ...stubs, ...overrides } as unknown as PgDbModule;
}

/** The export names this helper provides. Used by the parity guard to diff against the real module. */
export function pgDbMockExportNames(): string[] {
  return Object.keys(createPgDbMock()).sort();
}
