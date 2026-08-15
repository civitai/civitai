/**
 * The shared modules a test file must eventually stop mocking directly.
 *
 * Split by whether a canonical mock exists yet, because the two carry different
 * obligations — and because a single number covering only the first list would reach zero
 * with `isolate: false` still unflippable.
 *
 * 🔴 The flip criterion is NOT "the allowlist reaches zero". It is "every specifier a test
 * file shares with another test file has a canonical mock". The allowlist measures progress
 * toward that; it is not the criterion. Measured: a 120-file set clean for all of CANONICAL
 * still failed 110 tests at 4 workers under `--no-isolate`, entirely through specifiers in
 * PENDING — `No "isFliptSync" export is defined on the "~/server/flipt/client" mock`.
 *
 * 🔴 And reaching zero is still not sufficient to flip. `isolate: false` is gated on a
 * WHOLE-SUITE per-file collected-count diff against a `main` control, run immediately before
 * the flip — zero files may lose tests and the total must match exactly. Per-slice
 * verification cannot catch a file that belongs to no slice. See the flip gate in
 * docs/testing/shared-module-mock-migration.md.
 */

/** Have a canonical mock in `src/__tests__/mocks/`. Mocking these directly is a failure. */
export const CANONICAL_SPECIFIERS = [
  '~/server/db/client',
  '~/server/redis/client',
  '~/server/logging/client',
];

/**
 * No canonical mock yet. Counted, not enforced: with nothing to migrate to, enforcing would
 * only push every new test file onto the allowlist, which measures churn rather than work.
 *
 * 🔴 THIS LIST IS A FLOOR, NOT AN INVENTORY. It was assembled from the most-mocked specifiers
 * in a static scan, and specifiers keep arriving from the other direction — as failures in a
 * `--no-isolate` run of files that are residual-clean for everything listed. `flipt/client`
 * arrived that way. `~/server/middleware/block-scope.middleware` (27 files) is a live
 * candidate found the same way and is deliberately NOT added here without someone verifying
 * the mechanism.
 *
 * So the remaining work is DISCOVERED, not known, and any estimate built on the count below
 * is a lower bound. The way to find the next one is to migrate a set clean for everything
 * listed, run it under `--no-isolate`, and read what still fails.
 *
 * Ordered by remaining sites. `~/env/server` is the one to do first — all 114 of its mocks
 * are partial, and it is ALREADY globally mocked in `setup.ts` with a Proxy, so the canonical
 * shape exists and the work is per-file behaviour plus a reset rather than a new design.
 */
export const PENDING_SPECIFIERS = [
  '~/env/server',
  '~/server/services/buzz.service',
  '~/server/services/image.service',
  '~/server/clickhouse/client',
  '~/server/services/notification.service',
  '~/server/services/user.service',
  '~/server/search-index',
  '~/server/flipt/client',
  '~/server/redis/fail-open-log',
  '~/server/utils/endpoint-helpers',
  '~/server/redis/caches',
  '~/server/prom/client',
];

export const GUARDED_SPECIFIERS = [...CANONICAL_SPECIFIERS, ...PENDING_SPECIFIERS];

/** Matches `vi.mock('<spec>'` in any quote style. Textual on purpose: this runs over ~1,000
 * files on every `test:lint-rules`, and parsing each is not worth the seconds. */
export function mockPattern(specifier: string) {
  return new RegExp(`vi\\.mock\\(\\s*['"\`]${specifier.replace(/[/~.]/g, (c) => `\\${c}`)}['"\`]`);
}
