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
 * Three layers guard this, and these tests are the third:
 *
 *  1. `local-rules/no-wholesale-module-mock` (.eslintrc.js) rejects a hand-written pgDb factory at
 *     authoring time. It is `'error'`, and the "ESLint (added files)" CI step is BLOCKING — so a NEW test
 *     file cannot reintroduce the pattern.
 *  2. `src/test-utils/pgDbMock.ts` types its stub object as `Record<keyof typeof import(pgDb), unknown>`,
 *     so an export ADDED to pgDb fails `tsc` — naming the export, in one file. `Typecheck` is blocking too.
 *  3. These tests re-assert both invariants at runtime. They matter because the ESLint step that covers
 *     MODIFIED files is `continue-on-error` — only ADDED files are blocking — so a file edited to
 *     hand-roll a factory would slip past layer 1. This catches that.
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
        `[${extra.join(', ')}]. Remove them from the \`stubs\` object so the mock keeps matching reality.`
    ).toEqual([]);
  });

  it('is the only pgDb mock factory — no suite hand-rolls its own', () => {
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
    expect(testFiles.length, 'Walked src/ and found no test files — the scan is broken.').toBeGreaterThan(0);
    expect(fs.existsSync(helperPath), `Expected the shared helper at ${helperPath}`).toBe(true);

    const offenders = testFiles
      .filter((file) => {
        const body = fs.readFileSync(file, 'utf8');
        return body.includes("vi.mock('~/server/db/pgDb'") && !body.includes('createPgDbMock');
      })
      .map((file) => path.relative(srcRoot, file))
      .sort();

    expect(
      offenders,
      `${offenders.length} test file(s) hand-write their own \`vi.mock('~/server/db/pgDb', ...)\` factory ` +
        `instead of using the shared one:\n  ${offenders.join('\n  ')}\n\n` +
        `A hand-written factory lists only the exports that file happens to need today, which is exactly ` +
        `how adding an export to pgDb silently reds unrelated suites.\n\n` +
        `FIX: replace the factory body with\n` +
        `    vi.mock('~/server/db/pgDb', async () => {\n` +
        `      const { createPgDbMock } = await import('~/test-utils/pgDbMock');\n` +
        `      return createPgDbMock({ /* only the pools this suite drives */ });\n` +
        `    });`
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
