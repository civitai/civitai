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
 * runtime factory. A `vi.mock` factory is hoisted above imports, so it cannot reference a statically
 * imported helper; the only way to share one is
 * `async () => { const { f } = await import(...); return f(); }`. Keeping the literal avoids that async
 * indirection in 17 files and lets the single-sourcing live HERE instead, in one scan.
 *
 * ⚠️ RETRACTION, recorded because the wrong version was briefly committed: an earlier revision justified
 * this on PERFORMANCE, claiming the async form cost +36% on a 44s suite and +64% on a 15s one in CI. That
 * is false. It compared two runs on DIFFERENT pods without normalising for ambient speed. Normalised
 * against ~193 files, the async run and the sync run are indistinguishable — global median 1.43x vs the
 * baseline run, target file 1.36x, IDENTICAL in both. The async factory cost nothing measurable.
 *
 * What that measurement actually shows is unrelated to this file's design and worth knowing:
 * `get-models-raw.transient-503.test.ts` takes ~44s of a 60s per-test timeout on a fast pod, so a pod
 * running ~1.4x slower times it out. It is a pre-existing marginal-file flake, not a mocking problem.
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

/**
 * A `vi.mock` factory that SPREADS the real module supplies every export by construction, so the
 * key-by-key scan is inapplicable to it and it is exempt.
 *
 * 🔴 THIS IS A CORRECTNESS FIX, NOT A LOOSENING. The scan is a regex for `name:`, so it read
 * `...(await importOriginal<typeof PgDbModule>())` as supplying NOTHING and reported a suite using
 * it as "missing: pgDbReadLong, pgDbWrite". That suite was not missing them — it had the REAL ones.
 * Worse, the assertion message's own advice ("add `pgDbReadLong: {}`") would have REPLACED a real
 * export with an empty stub, turning a correct file into a broken one. Reproduced on PR #3584's
 * freshdesk suite, whose own tests collected and PASSED in the same CI run that this gate failed —
 * which is the proof the spread resolves.
 *
 * The hazard this gate exists for is `kyselyDb.ts` destructuring every export at module-eval time
 * and Vitest throwing on an omitted name. A spread omits no name, so the hazard is absent. The
 * spread form is also strictly SAFER than an inline literal: it cannot go stale the day the module
 * grows an export, which is the exact defect (#3579) that motivated this file.
 *
 * Not an endorsement of the async form everywhere — the NOTE in the assertion below still holds,
 * and an `importOriginal` factory is async, so prefer the sync literal where suite runtime matters.
 * This only stops reporting a safe pattern as a defect.
 */
export const SPREADS_ORIGINAL = /\.\.\.\s*\(?\s*await\s+importOriginal\s*[(<]/;

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

    // See `SPREADS_ORIGINAL` at module scope for why a spreading factory is exempt.
    const offenders = testFiles
      .map((file) => {
        const body = fs.readFileSync(file, 'utf8');
        const m = MOCK_CALL.exec(body);
        if (!m) return null;
        const span = factorySpan(body, m.index);
        if (SPREADS_ORIGINAL.test(span)) return null;
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

  // Pins the exemption BOTH ways. Widening it re-opens #3579 (a stale literal scans as compliant);
  // narrowing it re-breaks a correct suite AND hands out advice that would stub a real export.
  // Verified by execution against the scan itself: the ACCEPT case below was reported as
  // "missing: pgDbReadLong, pgDbWrite" before this exemption existed, and the REJECT cases were
  // still reported after it.
  it('exempts a factory that spreads the real module, and nothing else', () => {
    // ACCEPT — supplies every export by construction. Both the shape PR #3584 uses and its
    // whitespace/paren variants.
    for (const accept of [
      '...(await importOriginal<typeof PgDbModule>()),\n  pgDbRead: h.readPool,',
      '...(await importOriginal()),',
      '... await importOriginal(),',
      '...(\n    await importOriginal<typeof M>()\n  ),',
    ]) {
      expect(SPREADS_ORIGINAL.test(accept), `should be exempt: ${accept}`).toBe(true);
    }

    // REJECT — the real defect class, plus near-misses that must NOT buy an exemption.
    for (const reject of [
      'pgDbRead: {}', //                          the incomplete literal #3579 was about
      '...somethingElse,', //                     a spread of anything but the original module
      '...(await import("~/server/db/pgDb")),', // a bare dynamic import, not importOriginal
      'importOriginal', //                        the bare identifier, no spread
      '// ...(await importOriginal())', //        NOTE: a commented-out spread still matches; the
      //                                          scan is textual, so this stays a known limit
      //                                          rather than a silent claim (see below).
    ].slice(0, 4)) {
      expect(SPREADS_ORIGINAL.test(reject), `should NOT be exempt: ${reject}`).toBe(false);
    }

    // 🔴 STATED LIMIT, NOT PAPERED OVER: this is a TEXT scan, so a spread inside a comment or a
    // string would buy an exemption it should not. Same class as the `--`/`/* */` blind spot any
    // regex gate has. Accepted because the failure direction is a false GREEN on a file someone
    // deliberately commented out — far narrower than the false RED it replaces, which actively
    // told authors to break correct code.
    expect(SPREADS_ORIGINAL.test('// ...(await importOriginal())')).toBe(true);
  });
});
