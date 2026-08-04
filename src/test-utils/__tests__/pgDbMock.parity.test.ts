import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createPgDbMock, pgDbMockExportNames } from '~/test-utils/pgDbMock';

/**
 * Durability guard for the `~/server/db/pgDb` mock.
 *
 * The failure this exists to prevent: `kyselyDb.ts` destructures every pgDb export at module-eval time, and
 * Vitest's mocked-module proxy throws on a named export the factory omitted. That throw lands during module
 * LOAD, so it surfaces as the rejection value of whatever the suite was awaiting — the failures look like
 * assertion failures against intact production code, and a suite whose collection dies contributes zero
 * tests rather than reporting a failure. Adding one export to pgDb reddened unrelated suites twice already.
 *
 * TWO layers guard this:
 *
 *  1. `src/test-utils/pgDbMock.ts` types its stub object as `Record<keyof typeof import(pgDb), unknown>`.
 *     That is a TOTAL record, so an export ADDED to pgDb fails `tsc` — naming the export, in one file.
 *     `Typecheck` is a BLOCKING CI job (unlike `Unit tests`, which is `continue-on-error: true`), so this
 *     is caught before merge with one legible message instead of N obscure suite failures.
 *  2. These tests re-assert the same invariant at runtime, AND scan every suite that mocks pgDb to confirm
 *     its factory lists the full export set.
 *
 * 🔴 Each suite deliberately keeps its OWN inline, SYNCHRONOUS object literal rather than calling a shared
 * runtime factory. That is not an oversight — it was tried and measured, and reverted:
 *
 *   A `vi.mock` factory is hoisted above imports, so it cannot reference a statically-imported helper; the
 *   only way to share one is `async () => { const { f } = await import(...); return f(); }`. Making the
 *   factory async slowed EVERY converted suite in the CI pod, proportionally to the work it does:
 *   `get-models-raw.transient-503` 44.3s -> 60.3s (past the 60s per-test timeout, 9 tests red) and
 *   `challenge.metrics.completing-stuck` 14.8s -> 24.3s (+64%). It is invisible locally (~3.5s either way).
 *
 * So the single-sourcing lives HERE and in the canary, at zero runtime cost, instead of in an import that
 * every mocked suite has to pay for.
 */

// `pgDb` builds real `pg` pools via `getClient()` at module scope unless `env.IS_BUILD` is set. Stub the env
// so `vi.importActual` below can read the module's real EXPORT LIST without constructing a single pool or
// touching a database. `export let` bindings are listed on the module namespace whether or not they were
// ever assigned, so the key set is accurate even though every value is `undefined`.
vi.mock('~/env/server', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      // IS_BUILD short-circuits every `getClient()` call in pgDb.ts, so no pool is ever constructed.
      if (prop === 'IS_BUILD') return true;
      // pgDb.ts calls `createLogger()` at module scope, which reads `env.LOGGING.includes(...)`.
      if (prop === 'LOGGING') return [];
      return undefined;
    },
  }),
}));

describe('pgDb mock parity', () => {
  it('provides every export the real ~/server/db/pgDb module declares', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('~/server/db/pgDb');

    const realExports = Object.keys(actual).sort();
    const mockExports = pgDbMockExportNames();

    // Positive control on the instrument itself: if this read ever comes back empty, the assertion below
    // would be comparing an empty set to an empty set and would pass while proving nothing.
    expect(
      realExports.length,
      'Read ZERO exports from ~/server/db/pgDb — the parity check is not looking at the real module, ' +
        'so its verdict is meaningless. Fix this before trusting a pass.'
    ).toBeGreaterThan(0);

    const missing = realExports.filter((name) => !mockExports.includes(name));
    const extra = mockExports.filter((name) => !realExports.includes(name));

    expect(
      missing,
      `~/server/db/pgDb exports ${missing.length} name(s) that src/test-utils/pgDbMock.ts does NOT provide: ` +
        `[${missing.join(', ')}].\n\n` +
        `Any suite that mocks pgDb and whose import graph reaches kyselyDb will now fail at module load ` +
        `with "[vitest] No \\"<name>\\" export is defined on the \\"~/server/db/pgDb\\" mock" — which shows up ` +
        `as an assertion failure against production code, not as a mock problem.\n\n` +
        `FIX: add the export(s) to the \`stubs\` object in src/test-utils/pgDbMock.ts. One line each, one file.`
    ).toEqual([]);

    expect(
      extra,
      `src/test-utils/pgDbMock.ts provides ${extra.length} name(s) the real module no longer exports: ` +
        `[${extra.join(
          ', '
        )}]. Remove them from the \`stubs\` object so the mock keeps matching reality.`
    ).toEqual([]);
  });

  it('every suite mocking pgDb lists the complete export set in its inline factory', () => {
    const srcRoot = path.resolve(__dirname, '../..');
    const helperPath = path.join(srcRoot, 'test-utils', 'pgDbMock.ts');

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full, out);
        } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
          out.push(full);
        }
      }
      return out;
    };

    const testFiles = walk(srcRoot);

    // Positive control: the walk must actually find test files, and must find THIS file. A silently empty
    // walk (wrong root, changed layout) would make the assertion below vacuously true.
    expect(
      testFiles.length,
      'Walked src/ and found no test files — the scan is broken.'
    ).toBeGreaterThan(0);
    expect(fs.existsSync(helperPath), `Expected the shared helper at ${helperPath}`).toBe(true);

    // Match ANY quote style and both the `~/` alias and a relative specifier. The earlier version matched
    // only the single-quoted alias, so a byte-identical double-quoted factory scanned as zero offenders —
    // a false green. Verified with that exact pair.
    const MOCK_CALL = /vi\.mock\(\s*(['"`])(?:~\/server\/db\/pgDb|(?:\.\.?\/)+server\/db\/pgDb)\1/;

    /** Span of the factory's argument list, via balanced parens from the `vi.mock(` that opens it. */
    const factorySpan = (body: string, from: number): string => {
      const open = body.indexOf('(', from);
      let depth = 0;
      for (let i = open; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')' && --depth === 0) return body.slice(open, i);
      }
      return body.slice(open);
    };

    const required = pgDbMockExportNames();

    const offenders = testFiles
      .map((file) => {
        const body = fs.readFileSync(file, 'utf8');
        const m = MOCK_CALL.exec(body);
        if (!m) return null;
        const span = factorySpan(body, m.index);
        const missing = required.filter((name) => !new RegExp(`\\b${name}\\s*:`).test(span));
        return missing.length
          ? `${path.relative(srcRoot, file)} (missing: ${missing.join(', ')})`
          : null;
      })
      .filter((x): x is string => x !== null)
      .sort();

    expect(
      offenders,
      `${offenders.length} test file(s) mock ~/server/db/pgDb with an INCOMPLETE factory:\n  ` +
        `${offenders.join('\n  ')}\n\n` +
        `kyselyDb.ts destructures every pgDb export at module-eval time, and Vitest throws on any name the ` +
        `factory omits. That throw happens during module LOAD, so the suite dies at collection and reports ` +
        `ZERO tests rather than a failure — it just silently stops existing.\n\n` +
        `FIX: add the missing key(s) to that file's factory, e.g. \`pgDbReadLong: {}\`. The full required ` +
        `set is: ${required.join(', ')}.\n\n` +
        `NOTE: the factory is deliberately an inline SYNC object literal, not a shared runtime helper. ` +
        `A vi.mock factory is hoisted above imports, so sharing one requires an async dynamic import — ` +
        `measured in-pod at +36% on a 44s suite (pushing it past the 60s per-test timeout) and +64% on a ` +
        `15s one. The single-sourcing lives in THIS test plus the compile-time canary, at zero runtime cost.`
    ).toEqual([]);
  });

  it('lets a suite override only the pools it drives, leaving the rest inert', () => {
    const query = vi.fn();
    const mock = createPgDbMock({ pgDbWrite: { query } }) as unknown as Record<string, unknown>;

    expect(mock.pgDbWrite).toEqual({ query });
    // Untouched tiers still exist (that is the point) and stay inert rather than being auto-stubbed.
    expect(mock.pgDbRead).toEqual({});
    expect(mock.pgDbReadLong).toEqual({});
  });
});
