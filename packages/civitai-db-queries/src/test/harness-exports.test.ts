import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as publicSubpath from './compile-harness';
import * as internal from './harness';

/**
 * What the package's public `./test-harness` subpath is allowed to expose.
 *
 * `explainHarness` and `testDbUrl` resolve a connection string and fall back to
 * `process.env.DATABASE_URL` — a real environment's WRITER in any checkout that has one. The
 * Kysely/Prisma parity suite deliberately refuses that fallback (it demands
 * `KYSELY_PARITY_DATABASE_URL`, because it writes fixtures), and that refusal is only a real
 * property if nothing else the suite imports can reach `DATABASE_URL` either. So the subpath
 * exports the offline compile-only harness and nothing else: calling anything on it cannot open a
 * pool.
 *
 * This is a SEAM guard — it pins the relationship between two files, which is why it asserts an
 * exact ledger rather than "compileHarness is present". It fails if the surface GROWS (a
 * DB-reaching helper is moved or re-exported into the public module) and if it SHRINKS (the
 * harness is renamed and the parity suite's import silently starts resolving to something else).
 */
const PUBLIC_SUBPATH_EXPORTS = ['compileHarness'];

// The helpers that must stay package-internal, asserted below to actually EXIST. Without this the
// exclusion above is unfalsifiable: a test that lists what is absent passes just as well when the
// excluded names were never real.
const MUST_STAY_INTERNAL = ['explainHarness', 'testDbUrl'];

const packageJson = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8')
) as { exports: Record<string, string> };

describe('the ./test-harness subpath cannot reach DATABASE_URL', () => {
  it('exports exactly the offline compile harness', () => {
    expect(Object.keys(publicSubpath).sort()).toEqual(PUBLIC_SUBPATH_EXPORTS);
  });

  it('routes the subpath at that module, not at the DB-backed harness', () => {
    expect(packageJson.exports['./test-harness']).toBe('./src/test/compile-harness.ts');
  });

  it('keeps the DB-reaching helpers internal — and they exist, so the exclusion is real', () => {
    // Positive control on the exclusion: these are importable package-internally...
    expect(Object.keys(internal).sort()).toEqual(
      [...MUST_STAY_INTERNAL, ...PUBLIC_SUBPATH_EXPORTS].sort()
    );
    // ...and absent from the public module.
    for (const name of MUST_STAY_INTERNAL) expect(Object.keys(publicSubpath)).not.toContain(name);
  });
});
