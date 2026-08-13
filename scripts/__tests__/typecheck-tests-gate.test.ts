import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper module, no types; `scripts/` is outside every tsconfig program.
import {
  checkPlausibility,
  classifyEmptyAllowance,
  classifyRun,
  compare,
  countTestFilesInProgram,
  detectRenames,
  diffExcludes,
  isGatedTestFile,
  isTestFileLine,
  parseDiagnostics,
  stripJsonComments,
  testFileFloor,
  toPosixPath,
  validateBaseline,
} from '../ci/typecheck-tests-compare.mjs';

/**
 * `scripts/ci/typecheck-tests-gate.mjs` is a ratchet whose entire value rests on
 * one property: it must be UNABLE to report a confident zero. It shipped without
 * that property — a bad env var, a missing binary, a V8 abort, or tsc's `pretty`
 * output format each produced "0 error(s) across 0 file(s) … PASS", exit 0.
 *
 * Two tiers here, deliberately:
 *
 *  - the pure functions (parse / classify / plausibility / compare), driven
 *    directly, because those are where a wrong answer is produced;
 *  - the gate END TO END, driven through the `TYPECHECK_TESTS_WRAPPER` seam with
 *    stub "typecheckers" that exit the way each real failure does. A real
 *    repo-wide `tsc` run is minutes, so nobody would run one per case — and a
 *    control nobody runs is not a control.
 *
 * Every end-to-end case asserts a NON-ZERO exit and a message naming the real
 * problem. A test that only asserts "it did not pass" would still be satisfied by
 * a gate that fails for the wrong reason.
 */

const GATE = path.resolve(__dirname, '../ci/typecheck-tests-gate.mjs');
const REPO_ROOT = path.resolve(__dirname, '../..');

// Built by concatenation so this file's own source can never be mistaken for a
// diagnostic by the parser it is testing.
const TS = `error${' '}TS`;
const plain = (file: string, code = 2322) =>
  `${file}(1,1): ${TS}${code}: Type 'string' is not assignable to type 'number'.`;
const pretty = (file: string, code = 2322) =>
  `${file}:1:1 - ${TS}${code}: Type 'string' is not assignable to type 'number'.`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'typecheck-tests-gate-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- parsing

describe('parseDiagnostics', () => {
  it('counts plain-format diagnostics per file', () => {
    const out = [
      plain('src/a/__tests__/x.test.ts'),
      plain('src/a/__tests__/x.test.ts'),
      plain('src/b/__tests__/y.test.ts'),
    ].join('\n');
    const r = parseDiagnostics(out);
    expect(r.total).toBe(3);
    expect(r.counts.get('src/a/__tests__/x.test.ts')).toBe(2);
    expect(r.counts.get('src/b/__tests__/y.test.ts')).toBe(1);
    expect([...r.formats]).toEqual(['plain']);
  });

  it('counts PRETTY-format diagnostics too — the format that used to parse as zero', () => {
    // This is the regression case for the `pretty` hole: 801 real errors,
    // reported by tsc in the pretty shape, parsed to 0 and the gate said PASS.
    const out = [pretty('src/a/__tests__/x.test.ts'), pretty('src/b/__tests__/y.test.ts')].join(
      '\n'
    );
    const r = parseDiagnostics(out);
    expect(r.total).toBe(2);
    expect([...r.formats]).toEqual(['pretty']);
  });

  it('strips ANSI before matching, so a coloured pretty run still counts', () => {
    const esc = String.fromCharCode(27);
    const out = `${esc}[96msrc/a/__tests__/x.test.ts${esc}[0m:1:1 - ${esc}[91m${TS}2322${esc}[0m: nope`;
    expect(parseDiagnostics(out).total).toBe(1);
  });

  it('reports sawAnyErrorTs when the marker is present but nothing parses', () => {
    // The shape that must never read as clean: output that plainly contains
    // diagnostics in a form the parser does not understand.
    const r = parseDiagnostics(`some wrapper said ${TS}2322 happened somewhere`);
    expect(r.total).toBe(0);
    expect(r.sawAnyErrorTs).toBe(1);
  });

  it('returns zero for genuinely empty output', () => {
    const r = parseDiagnostics('');
    expect(r.total).toBe(0);
    expect(r.sawAnyErrorTs).toBe(0);
  });
});

// ------------------------------------------------------- outcome truth table

describe('classifyRun — a zero is only a measurement when the run succeeded', () => {
  const clean = { total: 0, sawAnyErrorTs: 0 };
  const errs = { total: 801, sawAnyErrorTs: 801 };

  it('accepts exit 0 with no diagnostics as a genuine clean run', () => {
    expect(classifyRun({ status: 0, signal: null, parsed: clean }).ok).toBe(true);
  });

  it('accepts a non-zero exit that carries diagnostics — the ordinary failing run', () => {
    expect(classifyRun({ status: 2, signal: null, parsed: errs }).ok).toBe(true);
  });

  it.each([
    ['a rejected TYPECHECK_HEAP_MB', 2],
    ['a missing binary', 127],
    ['a V8 heap abort', 134],
    ['an unknown tooling failure', 1],
  ])('REFUSES a non-zero exit with no diagnostics (%s -> %i)', (_why, status) => {
    const v = classifyRun({ status, signal: null, parsed: clean });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(String(status));
    expect(v.reason).toMatch(/FAILURE TO RUN/);
  });

  it('REFUSES a run killed by a signal', () => {
    const v = classifyRun({ status: null, signal: 'SIGKILL', parsed: clean });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('SIGKILL');
  });

  it('REFUSES exit 0 that nonetheless printed diagnostics', () => {
    const v = classifyRun({ status: 0, signal: null, parsed: errs });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/contradictory/);
  });

  it('REFUSES output whose diagnostics the parser could not read', () => {
    const v = classifyRun({ status: 0, signal: null, parsed: { total: 0, sawAnyErrorTs: 12 } });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/did NOT parse/);
  });

  // ------------------------------------------------------------------- F1
  // The control above used to require total === 0, making it a cliff at exactly
  // zero. A PARTIAL parse — the parser understanding a handful of a great many
  // marker-carrying lines — sailed through and was then reported as an
  // improvement, because every file it failed to parse scores as `fixed`.
  it('REFUSES a PARTIAL parse, not only a total one (the 99% undercount)', () => {
    const v = classifyRun({
      status: 2,
      signal: null,
      parsed: { total: 5, sawAnyErrorTs: 801, unparsed: 796 },
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('796');
    expect(v.reason).toContain('801');
    expect(v.reason).toMatch(/did NOT parse/);
  });

  it.each([
    [800, 801, 1],
    [1, 801, 800],
    [0, 1, 1],
  ])(
    'refuses on ANY divergence — %i parsed of %i marker lines (%i unaccounted)',
    (total, saw, unparsed) => {
      const v = classifyRun({ status: 2, signal: null, parsed: { total, sawAnyErrorTs: saw } });
      expect(v.ok).toBe(false);
      expect(v.reason).toContain(String(unparsed));
    }
  );

  it('names the actual unparsed text so a false positive is diagnosable, not just asserted', () => {
    const v = classifyRun({
      status: 2,
      signal: null,
      parsed: {
        total: 1,
        sawAnyErrorTs: 2,
        unparsed: 1,
        unparsedSample: [`${TS}18003: No inputs were found in config file`],
      },
    });
    expect(v.reason).toContain('TS18003');
  });

  it('ACCEPTS a fully-accounted-for run — the invariant must not false-positive', () => {
    // Measured against this repository: 801 diagnostics over 1451 output lines,
    // 650 of them message-continuation lines. Continuation lines do not carry
    // the marker, so unparsed is 0 and a real failing run still classifies ok.
    expect(
      classifyRun({
        status: 1,
        signal: null,
        parsed: { total: 801, sawAnyErrorTs: 801, unparsed: 0 },
      }).ok
    ).toBe(true);
  });

  it('still honours an explicit crash marker, but does not depend on one', () => {
    expect(classifyRun({ status: 1, signal: null, parsed: clean, crashMarker: true }).ok).toBe(
      false
    );
    // …and the SAME run without the marker is refused anyway. This is the
    // difference between a spelled control and a structural one.
    expect(classifyRun({ status: 1, signal: null, parsed: clean, crashMarker: false }).ok).toBe(
      false
    );
  });
});

describe('parseDiagnostics — the accounting the F1 control reads', () => {
  it('reports unparsed 0 when every marker line parsed, even with continuation lines', () => {
    const out = [
      plain('src/a/__tests__/x.test.ts'),
      "  Property 'mock' does not exist on type '() => void'.",
      plain('src/b/__tests__/y.test.ts'),
      '  Types of parameters are incompatible.',
    ].join('\n');
    const r = parseDiagnostics(out);
    expect(r.total).toBe(2);
    expect(r.sawAnyErrorTs).toBe(2);
    expect(r.unparsed).toBe(0);
  });

  it('counts and SAMPLES a fileless diagnostic — the real divergent shape', () => {
    // TS18003 / TS6053 carry the marker with no `path(line,col)` prefix. These
    // are exactly the outputs meaning "the program was not built as intended",
    // so refusing on them is correct rather than merely conservative.
    const r = parseDiagnostics(
      [plain('src/a/__tests__/x.test.ts'), `${TS}18003: No inputs were found in config file.`].join(
        '\n'
      )
    );
    expect(r.total).toBe(1);
    expect(r.sawAnyErrorTs).toBe(2);
    expect(r.unparsed).toBe(1);
    expect(r.unparsedSample[0]).toContain('18003');
  });

  it('caps the sample so a wholly-unparseable run cannot flood the log', () => {
    const r = parseDiagnostics(Array(50).fill(`${TS}9999: weird`).join('\n'));
    expect(r.unparsed).toBe(50);
    expect(r.unparsedSample).toHaveLength(3);
  });
});

describe('checkPlausibility', () => {
  it('refuses a measured zero against a non-empty baseline', () => {
    const v = checkPlausibility({ currentTotal: 0, baselineTotal: 801 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('801');
    expect(v.reason).toContain('TYPECHECK_TESTS_ALLOW_EMPTY');
  });
  it('allows it behind the explicit escape hatch', () => {
    expect(checkPlausibility({ currentTotal: 0, baselineTotal: 801, allowEmpty: true }).ok).toBe(
      true
    );
  });
  it('allows a zero when the baseline is also zero', () => {
    expect(checkPlausibility({ currentTotal: 0, baselineTotal: 0 }).ok).toBe(true);
  });

  // ------------------------------------------------------------------- F1
  // The zero was treated as a category; it is the extreme of a spectrum. A run
  // reporting 5 against a baseline of 801 is the same failure with one digit
  // changed, and it PASSED while printing "136 file(s) now clean".
  it('refuses a COLLAPSE, not only an exact zero', () => {
    const v = checkPlausibility({ currentTotal: 5, baselineTotal: 801 });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe('collapse');
    expect(v.reason).toContain('99.4%');
  });

  it.each([
    // 801 * 0.25 = 200.25, so 201 is the first allowed value and 200 is refused.
    [201, 801, true, 'the first ratio at or above the floor is allowed'],
    [200, 801, false, 'just under the floor is refused'],
    [300, 801, true, 'an ordinary large cleanup is not obstructed'],
    [800, 801, true, 'an unchanged run'],
  ])('current %i vs baseline %i -> ok=%s (%s)', (currentTotal, baselineTotal, ok) => {
    expect(checkPlausibility({ currentTotal, baselineTotal }).ok).toBe(ok);
  });

  it('does not fire on a SMALL baseline, where a big ratio swing is ordinary', () => {
    // 1 of 8 is an 87% drop but means nothing; the ratio is only informative
    // once there is enough to be a ratio of.
    expect(checkPlausibility({ currentTotal: 1, baselineTotal: 8 }).ok).toBe(true);
    expect(checkPlausibility({ currentTotal: 1, baselineTotal: 20 }).ok).toBe(false);
  });

  it('tags the two refusals differently, because the caller treats them differently', () => {
    expect(checkPlausibility({ currentTotal: 0, baselineTotal: 801 }).kind).toBe('empty');
    expect(checkPlausibility({ currentTotal: 5, baselineTotal: 801 }).kind).toBe('collapse');
    expect(checkPlausibility({ currentTotal: 801, baselineTotal: 801 }).kind).toBeNull();
  });
});

// --------------------------------------------------- F3: the escape hatch
describe('classifyEmptyAllowance — one env var must not be able to make CI green', () => {
  it('is inert when unset', () => {
    expect(classifyEmptyAllowance({ raw: undefined, writeBaseline: false })).toEqual({
      allowed: false,
      refuse: null,
      reason: null,
    });
  });

  it('REFUSES on a verdict run rather than ignoring it', () => {
    // Silently ignoring a control-disabling variable is its own confident-wrong:
    // the operator believes the control is off, the gate believes it is on, and
    // the log says nothing.
    const r = classifyEmptyAllowance({ raw: 'a perfectly good reason', writeBaseline: false });
    expect(r.allowed).toBe(false);
    expect(r.refuse).toMatch(/VERDICT run/);
    expect(r.refuse).toMatch(/--write-baseline only/);
  });

  it.each([['1'], ['true'], ['yes'], ['TRUE'], ['y'], ['on'], ['   1  ']])(
    'REFUSES the bare token %p even on the write path',
    (raw) => {
      const r = classifyEmptyAllowance({ raw, writeBaseline: true });
      expect(r.allowed).toBe(false);
      expect(r.refuse).toMatch(/is not a reason/);
    }
  );

  it.each([['short'], ['abcdefghijkl'], ['a'.repeat(40)]])(
    'REFUSES %p — too short, or a single word with no justification in it',
    (raw) => {
      expect(classifyEmptyAllowance({ raw, writeBaseline: true }).allowed).toBe(false);
    }
  );

  it('ALLOWS a written reason on the write path, and returns it for echoing', () => {
    const reason = 'test tree genuinely clean after PR #1234, regenerating';
    const r = classifyEmptyAllowance({ raw: reason, writeBaseline: true });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe(reason);
    expect(r.refuse).toBeNull();
  });
});

describe('testFileFloor', () => {
  it('derives the floor from the baseline count rather than a magic number', () => {
    expect(testFileFloor(938)).toEqual({ ok: true, floor: 844, derived: true, reason: null });
  });

  it.each([[undefined], [null]])(
    'falls back when the baseline genuinely records nothing (%p)',
    (v) => {
      // ABSENT is a legitimate state: a baseline written before the field existed.
      expect(testFileFloor(v as never)).toEqual({
        ok: true,
        floor: 400,
        derived: false,
        reason: null,
      });
    }
  );

  it('would have caught the shrink the old fixed floor allowed', () => {
    // 938 real files, old floor 400: 57% of the tree could leave and the control
    // stayed green, with the vanished files scored `fixed` -> PASS.
    const { floor } = testFileFloor(938);
    expect(400).toBeLessThan(floor);
    expect(500 < floor).toBe(true);
  });

  // ------------------------------------------------------------------- F2
  // The derived floor had no lower bound, so replacing the magic 400 with "a
  // value read from a file" made the control only as good as that value — while
  // still logging `derived: true`, i.e. still claiming to be the trustworthy
  // version. These are the cases that made it a no-op.
  it.each([
    [1, 'a one-file baseline yielded a floor of ZERO — no program can fail it'],
    [5, 'a five-file baseline yielded a floor of 4'],
    [100, 'any count below the fixed floor'],
  ])('NEVER lets a small recorded count (%i) lower the floor below the fixed one', (recorded) => {
    const r = testFileFloor(recorded);
    expect(r.ok).toBe(true);
    expect(r.floor).toBe(400);
    // and it must not claim the floor came from the baseline, because it did not
    expect(r.derived).toBe(false);
    expect(Math.floor(recorded * 0.9)).toBeLessThan(r.floor);
  });

  it('is exactly Math.max(fixed, derived) at the crossover', () => {
    // 445 * 0.9 = 400.5 -> 400, ties with the fallback and is not "derived".
    expect(testFileFloor(445)).toEqual({ ok: true, floor: 400, derived: false, reason: null });
    // 446 * 0.9 = 401.4 -> 401, the first count where the baseline wins.
    expect(testFileFloor(446)).toEqual({ ok: true, floor: 401, derived: true, reason: null });
  });

  it.each([
    [0, /zero or fewer/],
    [-1, /zero or fewer/],
    ['938', /not an integer/],
    [1.5, /not an integer/],
    [Number.NaN, /not an integer/],
    [{}, /not an integer/],
    [1e9, /sanity ceiling/],
  ])('REFUSES a corrupt recorded count (%p) rather than silently falling back', (v, re) => {
    const r = testFileFloor(v as never);
    expect(r.ok).toBe(false);
    expect(r.floor).toBeNull();
    expect(r.reason).toMatch(re);
  });

  it('refuses an absurd count because a permanently-red control is worse than none', () => {
    // The damage runs the OTHER way from every case above: an enormous floor
    // makes the positive control impossible to satisfy, and a gate that can
    // never go green is one people delete.
    expect(testFileFloor(100_001).ok).toBe(false);
    expect(testFileFloor(100_000).ok).toBe(true);
  });
});

// ------------------------------------------------------------- the predicate

describe('isGatedTestFile — matches the ACTUAL exclusion, not a substring', () => {
  it.each([
    'src/__tests__/pages/api/download/attachment-blocklist.test.ts',
    'src/components/Apps/__tests__/appListingCardView.test.ts',
    'src/server/services/deep/nested/__tests__/x.test.ts',
  ])('claims %s', (f) => expect(isGatedTestFile(f)).toBe(true));

  it.each([
    // In BOTH programs — `pnpm typecheck` already blocks on these, so demanding a
    // baseline entry here would double-count. The old `/__tests__/` substring
    // predicate claimed all 68 of them.
    'packages/civitai-db-schema/src/__tests__/drift.test.ts',
    'packages/civitai-redis/src/client/__tests__/x.test.ts',
    // Not under src/ at all.
    'tests/preview-model.spec.ts',
    'scripts/__tests__/typecheck.test.ts',
    'src/components/Apps/appListingCardView.test.ts',
  ])('does NOT claim %s', (f) => expect(isGatedTestFile(f)).toBe(false));
});

// ---------------------------------------------------------------- baseline

describe('validateBaseline', () => {
  it('accepts a well-formed baseline', () => {
    expect(
      validateBaseline(
        { config: 'tsconfig.tests.json', files: { 'a.ts': 2 } },
        'tsconfig.tests.json'
      )
    ).toEqual([]);
  });
  it('rejects a missing files object', () => {
    expect(validateBaseline({ config: 'tsconfig.tests.json' }, 'tsconfig.tests.json')).toEqual([
      expect.stringContaining('files'),
    ]);
  });
  it('rejects a non-object', () => {
    expect(validateBaseline(null, 'x')).toEqual([expect.stringContaining('not a JSON object')]);
    expect(validateBaseline([], 'x')).toEqual([expect.stringContaining('not a JSON object')]);
  });
  it('rejects a baseline measured against another config', () => {
    expect(validateBaseline({ config: 'tsconfig.json', files: {} }, 'tsconfig.tests.json')).toEqual(
      [expect.stringContaining('measured against')]
    );
  });
  it('rejects non-positive-integer counts', () => {
    const p = validateBaseline(
      { config: 'c', files: { 'a.ts': 0, 'b.ts': -1, 'c.ts': 1.5, 'd.ts': 'x' } },
      'c'
    );
    expect(p).toHaveLength(4);
  });

  // `totalErrors` is the number a human skims in review and the number a
  // hand-edit changes; nothing compared it to the entries it claims to
  // summarise, so a header saying 801 over a body summing to 5 was cosmetic and
  // unnoticed.
  it('cross-checks totalErrors against the sum of the file entries', () => {
    const p = validateBaseline({ config: 'c', totalErrors: 801, files: { 'a.ts': 5 } }, 'c');
    expect(p).toEqual([expect.stringContaining('sum to 5')]);
  });

  it('accepts a totalErrors that agrees', () => {
    expect(
      validateBaseline({ config: 'c', totalErrors: 7, files: { 'a.ts': 5, 'b.ts': 2 } }, 'c')
    ).toEqual([]);
  });

  it('accepts a baseline with no totalErrors at all (an older generator)', () => {
    expect(validateBaseline({ config: 'c', files: { 'a.ts': 5 } }, 'c')).toEqual([]);
  });

  it('rejects a non-integer totalErrors', () => {
    expect(validateBaseline({ config: 'c', totalErrors: '7', files: { 'a.ts': 7 } }, 'c')).toEqual([
      expect.stringContaining('non-negative integer'),
    ]);
  });

  it('holds for the REAL committed baseline', () => {
    // The cross-check is worth nothing if the file it is meant to protect does
    // not satisfy it. This is the positive control on the control.
    const real = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'scripts/ci/typecheck-tests-baseline.json'), 'utf8')
    );
    expect(validateBaseline(real, 'tsconfig.tests.json')).toEqual([]);
    expect(real.totalErrors).toBe(
      Object.values(real.files as Record<string, number>).reduce((a, b) => a + b, 0)
    );
  });
});

// ------------------------------------------------------------- the comparison

describe('compare', () => {
  const base = { 'src/a/__tests__/x.test.ts': 5, 'src/b/__tests__/y.test.ts': 2 };

  it('blocks a baselined file whose count ROSE', () => {
    const r = compare(
      new Map([
        ['src/a/__tests__/x.test.ts', 6],
        ['src/b/__tests__/y.test.ts', 2],
      ]),
      base
    );
    expect(r.blocked).toBe(true);
    expect(r.worsened).toEqual([{ file: 'src/a/__tests__/x.test.ts', was: 5, now: 6 }]);
    expect(r.newlyDirty).toEqual([]);
    expect(r.currentTotal).toBe(8);
    expect(r.baselineTotal).toBe(7);
  });

  it('passes a baselined file whose count FELL, and says so', () => {
    const r = compare(
      new Map([
        ['src/a/__tests__/x.test.ts', 1],
        ['src/b/__tests__/y.test.ts', 2],
      ]),
      base
    );
    expect(r.blocked).toBe(false);
    expect(r.improved).toEqual([{ file: 'src/a/__tests__/x.test.ts', was: 5, now: 1 }]);
  });

  it('passes a baselined file that became clean or was DELETED', () => {
    const r = compare(new Map([['src/b/__tests__/y.test.ts', 2]]), base);
    expect(r.blocked).toBe(false);
    expect(r.fixed).toEqual([{ file: 'src/a/__tests__/x.test.ts', was: 5 }]);
  });

  it('blocks a file with errors that is NOT in the baseline', () => {
    const r = compare(new Map([...Object.entries(base), ['src/c/__tests__/z.test.ts', 1]]), base);
    expect(r.blocked).toBe(true);
    expect(r.newlyDirty).toEqual([{ file: 'src/c/__tests__/z.test.ts', count: 1 }]);
  });

  it('blocks a pure RENAME, but reports it as a rename rather than a regression', () => {
    // Documented behaviour, not an accident: this gate cannot see file CONTENT,
    // so auto-forgiving a "looks like a rename" is a hole a real regression fits
    // through. It blocks, and names the former path.
    const r = compare(
      new Map([
        ['src/moved/__tests__/x.test.ts', 5],
        ['src/b/__tests__/y.test.ts', 2],
      ]),
      base
    );
    expect(r.blocked).toBe(true);
    expect(r.renames).toEqual([
      { from: 'src/a/__tests__/x.test.ts', to: 'src/moved/__tests__/x.test.ts', count: 5 },
    ]);
  });

  it('makes NO rename claim when two candidates share a basename', () => {
    const ambiguous = { 'src/a/__tests__/x.test.ts': 5, 'src/b/__tests__/x.test.ts': 5 };
    const r = compare(new Map([['src/c/__tests__/x.test.ts', 5]]), ambiguous);
    expect(r.blocked).toBe(true);
    expect(r.renames).toEqual([]);
  });

  it('makes no rename claim when the count also changed', () => {
    const r = compare(new Map([['src/moved/__tests__/x.test.ts', 9]]), {
      'src/a/__tests__/x.test.ts': 5,
    });
    expect(r.renames).toEqual([]);
  });

  it('treats an EMPTY baseline as "every dirty file is new"', () => {
    const r = compare(new Map([['src/a/__tests__/x.test.ts', 1]]), {});
    expect(r.blocked).toBe(true);
    expect(r.newlyDirty).toHaveLength(1);
  });

  it('passes an unchanged tree', () => {
    const r = compare(new Map(Object.entries(base)), base);
    expect(r.blocked).toBe(false);
    expect(r.improved).toEqual([]);
    expect(r.fixed).toEqual([]);
  });

  it('accepts a plain object as `current` as well as a Map', () => {
    expect(compare(base, base).blocked).toBe(false);
  });
});

describe('detectRenames', () => {
  it('is empty when nothing was fixed', () => {
    expect(detectRenames([{ file: 'a/x.ts', count: 1 }], [])).toEqual([]);
  });
});

// ---------------------------------------------------- tsconfig drift control

describe('the two tsconfig exclude lists differ by exactly one entry', () => {
  const read = (f: string) =>
    JSON.parse(stripJsonComments(readFileSync(path.join(REPO_ROOT, f), 'utf8')))
      .exclude as string[];

  it('holds for the REAL configs in this repo', () => {
    // The lists are written out verbatim in both files, so an addition to
    // tsconfig.json's exclude silently fails to reach the measurement program
    // and nothing else in the repo would notice. This is the thing that notices.
    const d = diffExcludes(
      read('tsconfig.json'),
      read('tsconfig.tests.json'),
      'src/**/__tests__/**'
    );
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual(['src/**/__tests__/**']);
    expect(d.ok).toBe(true);
  });

  it('fails when the base config gains an entry the tests config did not copy', () => {
    const base = ['node_modules', 'src/**/__tests__/**', 'src/generated/**'];
    const tests = ['node_modules'];
    const d = diffExcludes(base, tests, 'src/**/__tests__/**');
    expect(d.ok).toBe(false);
    expect(d.removed).toEqual(['src/**/__tests__/**', 'src/generated/**']);
  });

  it('fails when the tests config excludes something the base config does not', () => {
    const d = diffExcludes(['a', 'src/**/__tests__/**'], ['a', 'extra'], 'src/**/__tests__/**');
    expect(d.ok).toBe(false);
    expect(d.added).toEqual(['extra']);
  });

  it('fails when the removed entry is the WRONG one', () => {
    const d = diffExcludes(
      ['a', 'src/**/__tests__/**'],
      ['src/**/__tests__/**'],
      'src/**/__tests__/**'
    );
    expect(d.ok).toBe(false);
  });
});

describe('stripJsonComments', () => {
  it('removes line and block comments but keeps them inside strings', () => {
    const s = stripJsonComments('{ // hi\n "a": "http://x", /* b */ "c": 1, }');
    expect(JSON.parse(s)).toEqual({ a: 'http://x', c: 1 });
  });
});

// ------------------------------------------------------------ end to end

/**
 * A stub "typecheck wrapper". It answers `--listFilesOnly` with enough
 * `__tests__` paths to clear the positive control, and answers the verdict run
 * however the case under test demands.
 */
function wrapperStub(name: string, body: string) {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    [
      'const args = process.argv.slice(2);',
      "if (args.includes('--listFilesOnly')) {",
      '  const lines = [];',
      '  for (let i = 0; i < 950; i++) lines.push(`/repo/src/x${i}/__tests__/f${i}.test.ts`);',
      "  console.log(lines.join('\\n'));",
      '  process.exit(0);',
      '}',
      body,
    ].join('\n')
  );
  return file;
}

function fixtureBaseline(name: string, files: Record<string, number>, testFilesInProgram = 938) {
  const file = path.join(dir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      config: 'tsconfig.tests.json',
      testFilesInProgram,
      totalErrors: Object.values(files).reduce((a, b) => a + b, 0),
      files,
    })
  );
  return file;
}

function runGate(
  wrapper: string,
  baseline: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = {}
) {
  const res = spawnSync(process.execPath, [GATE, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TYPECHECK_TESTS_WRAPPER: wrapper,
      TYPECHECK_TESTS_BASELINE: baseline,
      TYPECHECK_TESTS_ALLOW_EMPTY: '',
      TYPECHECK_TESTS_CONFIG_DIR: '',
      ...env,
    },
  });
  return { ...res, all: `${res.stdout}${res.stderr}` };
}

const BASE_FILES = { 'src/a/__tests__/x.test.ts': 5, 'src/b/__tests__/y.test.ts': 2 };

describe('the gate, end to end: a broken checker must never PASS', () => {
  it.each([
    ['exit 2, silent (a rejected TYPECHECK_HEAP_MB)', 'process.exit(2);'],
    ['exit 127, silent (the binary is not there)', 'process.exit(127);'],
    ['exit 134, silent (a V8 heap abort)', 'process.exit(134);'],
    ['exit 1, silent (an unclassified tooling failure)', 'process.exit(1);'],
  ])('%s -> exit 3, never 0', (label, body) => {
    const res = runGate(
      wrapperStub(`broken-${label.replace(/\W+/g, '-')}`, body),
      fixtureBaseline('b1', BASE_FILES)
    );
    expect(res.status).toBe(3);
    expect(res.all).toContain('CANNOT MEASURE');
    expect(res.all).toMatch(/FAILURE TO RUN/);
    // The verdict line the broken gate used to print. Its absence is the fix.
    expect(res.all).not.toContain('PASS —');
  });

  it('a run killed by a signal -> exit 3', () => {
    const res = runGate(
      wrapperStub('killed', 'process.kill(process.pid, "SIGKILL");'),
      fixtureBaseline('b2', BASE_FILES)
    );
    expect(res.status).toBe(3);
    expect(res.all).toContain('CANNOT MEASURE');
  });

  it('an honest zero against a non-empty baseline -> exit 3, not a celebration', () => {
    // exit 0 with no diagnostics is a legal outcome, so the truth table passes it
    // — and the plausibility control is what stops it. Both are needed.
    const res = runGate(
      wrapperStub('clean', 'process.exit(0);'),
      fixtureBaseline('b3', BASE_FILES)
    );
    expect(res.status).toBe(3);
    expect(res.all).toContain('almost certainly not measured anything');
  });

  // ------------------------------------------------------------------- F3
  // This case previously asserted the OPPOSITE — that the hatch turned this same
  // zero into `PASS`, exit 0. That is precisely the CI blocker: a wrapper that
  // measures nothing printed "0 error(s) across 0 file(s) (baseline: 7 across 2)"
  // -> "2 file(s) now clean" -> PASS, with nothing in the output recording that a
  // control had been switched off. One env var in one job definition.
  it('REFUSES the escape hatch on a verdict run — it cannot make CI green', () => {
    const res = runGate(
      wrapperStub('clean2', 'process.exit(0);'),
      fixtureBaseline('b4', BASE_FILES),
      [],
      { TYPECHECK_TESTS_ALLOW_EMPTY: '1' }
    );
    expect(res.status).toBe(3);
    expect(res.all).toContain('REFUSING TO RUN');
    expect(res.all).toMatch(/VERDICT run/);
    expect(res.all).not.toContain('PASS —');
    expect(res.all).not.toContain('now clean');
  });

  it('refuses it with a WRITTEN reason too — scope, not wording, is the control', () => {
    const res = runGate(
      wrapperStub('clean3', 'process.exit(0);'),
      fixtureBaseline('b4b', BASE_FILES),
      [],
      { TYPECHECK_TESTS_ALLOW_EMPTY: 'the tree really is clean, honestly' }
    );
    expect(res.status).toBe(3);
    expect(res.all).not.toContain('PASS —');
  });

  it('a COLLAPSE shouts but does not block a verdict run, and cannot read as clean', () => {
    // Split by reversibility: a collapsed verdict run cannot hide a regression
    // (a regression is what `compare` blocks on; a collapse makes files look
    // FIXED), so refusing would block a legitimate cleanup for no safety gain.
    const many: Record<string, number> = {};
    for (let i = 0; i < 40; i++) many[`src/f${i}/__tests__/a.test.ts`] = 1;
    const res = runGate(
      wrapperStub(
        'collapsed',
        `console.log(${JSON.stringify(plain('src/f0/__tests__/a.test.ts'))});
process.exit(2);`
      ),
      fixtureBaseline('b6', many)
    );
    expect(res.status).toBe(0);
    expect(res.all).toContain('IMPLAUSIBLE MEASUREMENT');
    expect(res.all).toContain('97.5%');
    // and the shout must precede the verdict, not trail it
    expect(res.all.indexOf('IMPLAUSIBLE MEASUREMENT')).toBeLessThan(res.all.indexOf('PASS —'));
  });

  it('a PARTIAL parse is refused end to end — the F1 undercount', () => {
    // 5 parseable diagnostics alongside 20 marker lines the parser cannot read.
    // Before: classified ok, then reported as files "now clean".
    const body = [
      `const l = [${JSON.stringify(plain('src/a/__tests__/x.test.ts'))}];`,
      `for (let i=0;i<20;i++) l.push("${'error' + ' '}TS18003: No inputs were found.");`,
      "console.log(l.join('\\n'));",
      'process.exit(2);',
    ].join('\n');
    const res = runGate(wrapperStub('partial', body), fixtureBaseline('b7', BASE_FILES));
    expect(res.status).toBe(3);
    expect(res.all).toContain('CANNOT MEASURE');
    expect(res.all).toMatch(/did NOT parse/);
    expect(res.all).toContain('TS18003');
    expect(res.all).not.toContain('now clean');
  });

  // A one-file `--listFilesOnly` program against a baseline recording ONE test
  // file. Before F2 this derived a floor of ZERO, which no program can fail, so
  // the gate proceeded and measured a single file while logging that its floor
  // came from the baseline. The Math.max is what turns this into a refusal.
  it('a floor derived from a tiny baseline cannot fall below the fixed one, end to end', () => {
    const bl = path.join(dir, 'tinycount.json');
    writeFileSync(
      bl,
      JSON.stringify({
        config: 'tsconfig.tests.json',
        testFilesInProgram: 1,
        totalErrors: 7,
        files: BASE_FILES,
      })
    );
    const stub = path.join(dir, 'tiny.mjs');
    writeFileSync(
      stub,
      [
        'const args = process.argv.slice(2);',
        "if (args.includes('--listFilesOnly')) {",
        '  console.log("/repo/src/a/__tests__/only.test.ts"); process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n')
    );
    const res = runGate(stub, bl);
    expect(res.status).toBe(3);
    expect(res.all).toContain('POSITIVE CONTROL FAILED');
    expect(res.all).toContain('400');
    expect(res.all).not.toContain('PASS —');
  });

  it.each([['938'], [-5], [1.5], [999999]])(
    'REFUSES outright when the baseline records a corrupt testFilesInProgram (%p)',
    (recorded) => {
      // Distinct call site from the floor comparison above, and it was NOT
      // pinned by it: with `if (!floorResult.ok)` neutered, `floor` is null,
      // `testFilesInProgram < null` is false, and the gate sails past both
      // checks into a verdict. The battery caught this as a surviving mutant.
      const bl = path.join(dir, `corrupt-${String(recorded).replace(/\W/g, '_')}.json`);
      writeFileSync(
        bl,
        JSON.stringify({
          config: 'tsconfig.tests.json',
          testFilesInProgram: recorded,
          totalErrors: 7,
          files: BASE_FILES,
        })
      );
      const res = runGate(workingWrapper(`corrupt-${String(recorded).replace(/\W/g, '_')}`), bl);
      expect(res.status).toBe(3);
      expect(res.all).toContain('no usable floor');
      expect(res.all).not.toContain('PASS —');
      expect(res.all).not.toContain('positive control OK');
    }
  );

  it('a shrunken program trips the baseline-derived positive control', () => {
    const stub = path.join(dir, 'shrunk.mjs');
    writeFileSync(
      stub,
      [
        'const args = process.argv.slice(2);',
        "if (args.includes('--listFilesOnly')) {",
        // 500 files: comfortably over the OLD fixed floor of 400, comfortably
        // under 90% of the 938 the baseline was measured across.
        '  const lines = []; for (let i=0;i<500;i++) lines.push(`/repo/src/x${i}/__tests__/f${i}.test.ts`);',
        "  console.log(lines.join('\\n')); process.exit(0);",
        '}',
        'process.exit(0);',
      ].join('\n')
    );
    const res = runGate(stub, fixtureBaseline('b5', BASE_FILES, 938));
    expect(res.status).toBe(3);
    expect(res.all).toContain('POSITIVE CONTROL FAILED');
    expect(res.all).toContain('500');
    expect(res.all).toContain('844');
  });
});

describe('the gate, end to end: a working checker produces the right verdict', () => {
  const emit = (lines: string[], code = 2) =>
    `console.log(${JSON.stringify(lines.join('\n'))});\nprocess.exit(${code});`;

  const unchanged = [
    ...Array(5).fill(plain('src/a/__tests__/x.test.ts')),
    ...Array(2).fill(plain('src/b/__tests__/y.test.ts')),
  ];

  it('PASSES an unchanged tree, with real counts', () => {
    const res = runGate(wrapperStub('same', emit(unchanged)), fixtureBaseline('c1', BASE_FILES));
    expect(res.status).toBe(0);
    expect(res.all).toContain('7 error(s) across 2 file(s) (baseline: 7 across 2)');
    expect(res.all).toContain('PASS —');
  });

  it('BLOCKS a newly dirty file and names it', () => {
    const res = runGate(
      wrapperStub('newdirty', emit([...unchanged, plain('src/c/__tests__/z.test.ts')])),
      fixtureBaseline('c2', BASE_FILES)
    );
    expect(res.status).toBe(1);
    expect(res.all).toContain('BLOCKED');
    expect(res.all).toContain('src/c/__tests__/z.test.ts  (1)');
  });

  it('BLOCKS a worsened baselined file with was -> now', () => {
    const res = runGate(
      wrapperStub('worse', emit([...unchanged, plain('src/a/__tests__/x.test.ts')])),
      fixtureBaseline('c3', BASE_FILES)
    );
    expect(res.status).toBe(1);
    expect(res.all).toContain('src/a/__tests__/x.test.ts  5 -> 6');
  });

  it('PASSES improvement and reports it', () => {
    const res = runGate(
      wrapperStub(
        'better',
        emit([
          plain('src/a/__tests__/x.test.ts'),
          ...Array(2).fill(plain('src/b/__tests__/y.test.ts')),
        ])
      ),
      fixtureBaseline('c4', BASE_FILES)
    );
    expect(res.status).toBe(0);
    expect(res.all).toContain('1 improved');
  });

  it('BLOCKS a rename and names the former path', () => {
    const res = runGate(
      wrapperStub(
        'renamed',
        emit([
          ...Array(5).fill(plain('src/moved/__tests__/x.test.ts')),
          ...Array(2).fill(plain('src/b/__tests__/y.test.ts')),
        ])
      ),
      fixtureBaseline('c5', BASE_FILES)
    );
    expect(res.status).toBe(1);
    expect(res.all).toContain('look like a RENAME');
    expect(res.all).toContain('src/a/__tests__/x.test.ts  ->  src/moved/__tests__/x.test.ts');
  });

  it('parses a PRETTY-format run identically — the format that used to PASS at zero', () => {
    const res = runGate(
      wrapperStub(
        'prettyfmt',
        emit([
          ...Array(5).fill(pretty('src/a/__tests__/x.test.ts')),
          ...Array(2).fill(pretty('src/b/__tests__/y.test.ts')),
        ])
      ),
      fixtureBaseline('c6', BASE_FILES)
    );
    expect(res.status).toBe(0);
    expect(res.all).toContain('in pretty format');
    expect(res.all).toContain('7 error(s) across 2 file(s)');
  });

  it('ignores diagnostics outside src/**/__tests__/ instead of demanding a baseline entry', () => {
    const res = runGate(
      wrapperStub(
        'pkgs',
        emit([...unchanged, plain('packages/civitai-db/src/__tests__/q.test.ts')])
      ),
      fixtureBaseline('c7', BASE_FILES)
    );
    expect(res.status).toBe(0);
    expect(res.all).toContain('1 file(s) with errors outside src/**/__tests__/');
  });
});

describe('the gate, end to end: --write-baseline refuses to zero the ratchet', () => {
  it('refuses to write when the checker could not run, and leaves the file untouched', () => {
    const bl = fixtureBaseline('w1', BASE_FILES);
    const before = readFileSync(bl, 'utf8');
    const res = runGate(wrapperStub('wbroken', 'process.exit(127);'), bl, ['--write-baseline']);
    expect(res.status).toBe(3);
    expect(res.all).toContain('CANNOT MEASURE');
    expect(readFileSync(bl, 'utf8')).toBe(before);
  });

  it('refuses to write a ZERO over a non-empty baseline', () => {
    const bl = fixtureBaseline('w2', BASE_FILES);
    const before = readFileSync(bl, 'utf8');
    const res = runGate(wrapperStub('wclean', 'process.exit(0);'), bl, ['--write-baseline']);
    expect(res.status).toBe(3);
    expect(res.all).toContain('almost certainly not measured anything');
    expect(readFileSync(bl, 'utf8')).toBe(before);
  });

  it('applies the BASELINE-DERIVED positive-control floor on the write path too', () => {
    // Regeneration is the one mode with no ratchet of its own. It borrows the
    // floor from the baseline it is about to replace; otherwise every control
    // falls back to its weakest setting in exactly the operation that can
    // destroy the ratchet.
    const stub = path.join(dir, 'wshrunk.mjs');
    writeFileSync(
      stub,
      [
        'const args = process.argv.slice(2);',
        "if (args.includes('--listFilesOnly')) {",
        '  const l = []; for (let i=0;i<500;i++) l.push(`/repo/src/x${i}/__tests__/f${i}.test.ts`);',
        "  console.log(l.join('\\n')); process.exit(0);",
        '}',
        `console.log(${JSON.stringify(plain('src/a/__tests__/x.test.ts'))});`,
        'process.exit(2);',
      ].join('\n')
    );
    const bl = fixtureBaseline('w4', BASE_FILES, 938);
    const before = readFileSync(bl, 'utf8');
    const res = runGate(stub, bl, ['--write-baseline']);
    expect(res.status).toBe(3);
    expect(res.all).toContain('POSITIVE CONTROL FAILED');
    expect(res.all).toContain('844');
    expect(readFileSync(bl, 'utf8')).toBe(before);
  });

  it('writes a real measurement, including the test-file count the control needs', () => {
    const bl = fixtureBaseline('w3', BASE_FILES);
    const res = runGate(
      wrapperStub(
        'wgood',
        `console.log(${JSON.stringify(plain('src/a/__tests__/x.test.ts'))});\nprocess.exit(2);`
      ),
      bl,
      ['--write-baseline']
    );
    expect(res.status).toBe(0);
    const written = JSON.parse(readFileSync(bl, 'utf8'));
    expect(written.totalErrors).toBe(1);
    expect(written.testFilesInProgram).toBe(950);
    expect(written.files).toEqual({ 'src/a/__tests__/x.test.ts': 1 });
  });
});

// ------------------------------------------------------------------- F5
/**
 * Every control above is a pure function that is well covered AND a call site in
 * the gate that decides whether to act on it. Those are two different things,
 * and the second was not pinned: mutating `if (!drift.ok)` to `if (false)` left
 * the suite 78/78 GREEN. `diffExcludes` was thoroughly tested and the control
 * was live in production — but nothing asserted the gate READ it, which is the
 * same class of gap this PR exists to close, inside this PR's own suite.
 *
 * These cases drive the gate end to end through the `TYPECHECK_TESTS_CONFIG_DIR`
 * seam. Each asserts the SPECIFIC message of the control under test, not merely
 * a non-zero exit: several of these call sites are outcome-equivalent (they all
 * end in exit 3 via some later check), so an exit-code assertion would survive
 * the mutation and prove nothing.
 */
function configDir(name: string, base: string[], tests: string[]) {
  const d = path.join(dir, `cfg-${name}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'tsconfig.json'), JSON.stringify({ exclude: base }));
  writeFileSync(path.join(d, 'tsconfig.tests.json'), JSON.stringify({ exclude: tests }));
  return d;
}

const OK_BASE = ['node_modules', 'src/**/__tests__/**'];
const OK_TESTS = ['node_modules'];

function workingWrapper(name: string) {
  return wrapperStub(
    name,
    [
      `const l = [${JSON.stringify(plain('src/a/__tests__/x.test.ts'))}];`,
      'const out = [];',
      'for (let i=0;i<5;i++) out.push(l[0]);',
      `for (let i=0;i<2;i++) out.push(${JSON.stringify(plain('src/b/__tests__/y.test.ts'))});`,
      "console.log(out.join('\\n'));",
      'process.exit(2);',
    ].join('\n')
  );
}

describe('the gate ACTS on its controls, not merely computes them', () => {
  it('CONTROL ARM: an undrifted fixture pair passes, so the arm below attributes', () => {
    // Without this, a refusal from the drift case could be caused by anything
    // about the fixture directory rather than by the drift itself.
    const res = runGate(workingWrapper('drift-ok'), fixtureBaseline('d0', BASE_FILES), [], {
      TYPECHECK_TESTS_CONFIG_DIR: configDir('ok', OK_BASE, OK_TESTS),
    });
    expect(res.status).toBe(0);
    expect(res.all).toContain('PASS —');
  });

  it('acts on config DRIFT — the call site that survived `if (false)`', () => {
    const res = runGate(workingWrapper('drift-bad'), fixtureBaseline('d1', BASE_FILES), [], {
      TYPECHECK_TESTS_CONFIG_DIR: configDir('drift', [...OK_BASE, 'src/generated/**'], OK_TESTS),
    });
    expect(res.status).toBe(3);
    expect(res.all).toContain('no longer');
    expect(res.all).toContain('src/generated/**');
    expect(res.all).not.toContain('PASS —');
  });

  it('acts on drift in the other direction too (the tests config adds an exclude)', () => {
    const res = runGate(workingWrapper('drift-add'), fixtureBaseline('d2', BASE_FILES), [], {
      TYPECHECK_TESTS_CONFIG_DIR: configDir('added', OK_BASE, [...OK_TESTS, 'src/extra/**']),
    });
    expect(res.status).toBe(3);
    expect(res.all).toContain('src/extra/**');
  });

  it('acts on an UNREADABLE tsconfig — the catch arm around the drift check', () => {
    const d = path.join(dir, 'cfg-broken');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'tsconfig.json'), '{ this is not json');
    writeFileSync(path.join(d, 'tsconfig.tests.json'), JSON.stringify({ exclude: OK_TESTS }));
    const res = runGate(workingWrapper('cfg-broken-w'), fixtureBaseline('d3', BASE_FILES), [], {
      TYPECHECK_TESTS_CONFIG_DIR: d,
    });
    expect(res.status).toBe(3);
    expect(res.all).toContain('could not compare the two tsconfig exclude lists');
  });

  it('acts on the POSITIVE CONTROL ARM failing, with its OWN message', () => {
    // Known outcome-equivalent site: if the gate ignored `listed.verdict.ok`,
    // the file count would be 0 and the floor check would refuse anyway — same
    // exit 3, worse message. Asserting the message is what makes this a real
    // pin rather than a restatement of the next check.
    const stub = path.join(dir, 'listfail.mjs');
    writeFileSync(
      stub,
      [
        'const args = process.argv.slice(2);',
        "if (args.includes('--listFilesOnly')) process.exit(127);",
        `console.log(${JSON.stringify(plain('src/a/__tests__/x.test.ts'))});`,
        'process.exit(2);',
      ].join('\n')
    );
    const res = runGate(stub, fixtureBaseline('d4', BASE_FILES));
    expect(res.status).toBe(3);
    expect(res.all).toContain('the positive control could not run');
    expect(res.all).toContain('127');
  });

  it('echoes PROVENANCE, so a stub-driven run is not byte-identical to a real one', () => {
    const res = runGate(workingWrapper('prov'), fixtureBaseline('d5', BASE_FILES));
    expect(res.all).toContain('provenance —');
    expect(res.all).toContain('[OVERRIDE]');
    expect(res.all).toContain('TYPECHECK_TESTS_WRAPPER');
    expect(res.all).toMatch(/did NOT necessarily measure this repository/);
  });
});

describe('the gate, end to end: an unusable baseline is exit 2, not a pass', () => {
  it('rejects malformed JSON', () => {
    const bl = path.join(dir, 'bad.json');
    writeFileSync(bl, '{ not json');
    const res = runGate(wrapperStub('bj', 'process.exit(0);'), bl);
    expect(res.status).toBe(2);
    expect(res.all).toContain('not valid JSON');
  });

  it('rejects a baseline with no files object', () => {
    const bl = path.join(dir, 'nofiles.json');
    writeFileSync(bl, JSON.stringify({ config: 'tsconfig.tests.json' }));
    const res = runGate(wrapperStub('nf', 'process.exit(0);'), bl);
    expect(res.status).toBe(2);
    expect(res.all).toContain('files');
  });

  it('rejects an absent baseline', () => {
    const res = runGate(wrapperStub('abs', 'process.exit(0);'), path.join(dir, 'nope.json'));
    expect(res.status).toBe(2);
    expect(res.all).toContain('baseline not found');
  });

  it('rejects a baseline measured against a different config', () => {
    const bl = path.join(dir, 'otherconfig.json');
    writeFileSync(bl, JSON.stringify({ config: 'tsconfig.json', files: BASE_FILES }));
    const res = runGate(wrapperStub('oc', 'process.exit(0);'), bl);
    expect(res.status).toBe(2);
    expect(res.all).toContain('measured against');
  });
});

// ------------------------------------------------------- the platform seam
/**
 * REGRESSION COVERAGE — reported by a developer running `pnpm run test:unit:run`
 * on Windows, where 18 of this file's cases were RED while CI stayed green.
 *
 * The gate built its `__tests__` marker out of `path.sep`
 * (`` `${path.sep}__tests__${path.sep}` ``) and matched it against the output of
 * `tsc --listFilesOnly`. **tsc emits FORWARD slashes on every platform, Windows
 * included.** On Windows `path.sep` is `\`, so the marker matched nothing: 948
 * output lines containing `__tests__`, 0 matching the marker, positive control
 * trips, `CANNOT MEASURE — POSITIVE CONTROL FAILED … contains 0 file(s)`.
 *
 * WHY THE EXISTING SUITE COULD NOT SEE IT. Every case ran on Linux, where
 * `path.sep === '/'`, so the marker happened to equal the shape tsc emits. The
 * platform was a PINNED DIMENSION — not under-tested, structurally invisible:
 * no amount of extra cases written the same way could have moved it, because
 * every one of them would have read the same host separator.
 *
 * SO THESE CASES NEVER READ `path.sep`. They name both separators explicitly via
 * `path.win32.sep` / `path.posix.sep`, which are the same two characters on every
 * host, and they drive the gate end to end with `--listFilesOnly` output in each
 * shape. That is what makes them mean the same thing on Linux and on Windows.
 */

// Always '\' and always '/', on every host. The whole point: the assertions
// below are about a SEPARATOR, not about the machine running them.
const WIN_SEP = path.win32.sep;
const POSIX_SEP = path.posix.sep;

/**
 * The pre-fix predicate, transcribed verbatim from
 * `typecheck-tests-gate.mjs`, with the one thing it read from the host — the
 * separator — lifted into a parameter. This is the injection the production code
 * could not offer: it read `path.sep` at module scope, which is exactly what made
 * the behaviour untestable in-process.
 */
const preFixPredicate = (line: string, sep: string) =>
  line.includes(`${sep}__tests__${sep}`) && !line.includes(`${sep}node_modules${sep}`);

// The two shapes of the same path. `posixShaped` is what tsc ACTUALLY emits, on
// both platforms; `winShaped` is what a naive reader assumes it emits on Windows.
const posixShaped = 'C:/repo/src/a/__tests__/x.test.ts';
const winShaped = 'C:\\repo\\src\\a\\__tests__\\x.test.ts';

describe('the __tests__ marker must not depend on the host separator', () => {
  it('DOCUMENTS THE DEFECT: the pre-fix marker cannot match tsc output on Windows', () => {
    // Both halves are host-independent facts, so this case asserts the same
    // thing wherever it runs — including on the Windows box that reported it.
    expect(preFixPredicate(posixShaped, WIN_SEP)).toBe(false); // <- the Windows box
    expect(preFixPredicate(posixShaped, POSIX_SEP)).toBe(true); // <- CI, green by luck
  });

  it.each([
    ['posix-shaped (what tsc emits, everywhere)', posixShaped],
    ['windows-shaped (a backslash path, if one ever reaches us)', winShaped],
  ])('isTestFileLine claims a %s line', (_label, line) => {
    expect(isTestFileLine(line)).toBe(true);
  });

  it.each([
    ['posix-shaped', 'C:/repo/node_modules/pkg/src/a/__tests__/x.test.ts'],
    ['windows-shaped', 'C:\\repo\\node_modules\\pkg\\src\\a\\__tests__\\x.test.ts'],
  ])('isTestFileLine still excludes node_modules in a %s line', (_label, line) => {
    // The exclusion half was built from `path.sep` too. Normalising only the
    // marker and not this one would let vendored test files inflate the count —
    // a positive control that passes by counting the wrong population.
    expect(isTestFileLine(line)).toBe(false);
  });

  it('countTestFilesInProgram counts BOTH shapes in one listing, and neither vendored one', () => {
    const listing = [
      posixShaped,
      winShaped,
      'C:/repo/node_modules/pkg/src/a/__tests__/x.test.ts',
      'C:\\repo\\node_modules\\pkg\\src\\a\\__tests__\\x.test.ts',
      'C:/repo/src/a/notATest.ts',
      'C:\\repo\\src\\a\\notATest.ts',
    ].join('\n');
    expect(countTestFilesInProgram(listing)).toBe(2);
  });

  it('toPosixPath is idempotent and leaves an already-posix path alone', () => {
    expect(toPosixPath(winShaped)).toBe(posixShaped);
    expect(toPosixPath(posixShaped)).toBe(posixShaped);
    expect(toPosixPath(toPosixPath(winShaped))).toBe(posixShaped);
  });

  it('a diagnostic path is normalised to posix, so BASELINE KEYS are host-independent', () => {
    // The baseline is a committed JSON file whose keys come straight from this
    // parse. Normalising with `split(path.sep)` meant the key a Windows machine
    // produced and the key a Linux machine produced were only ever equal because
    // tsc happens to emit one shape. A key built with a host separator would
    // never match the committed baseline written on the other host.
    const r = parseDiagnostics(
      [plain('src\\a\\__tests__\\x.test.ts'), plain('src/a/__tests__/x.test.ts')].join('\n')
    );
    expect(r.counts.get('src/a/__tests__/x.test.ts')).toBe(2);
    expect([...r.counts.keys()]).toEqual(['src/a/__tests__/x.test.ts']);
    // and the normalised key is one `isGatedTestFile` claims — the predicate is
    // written against forward slashes, so a backslash key would be silently
    // discarded as "outside src/**/__tests__/".
    expect(isGatedTestFile([...r.counts.keys()][0])).toBe(true);
  });

  it('LEDGER: neither production module reads path.sep in executable code', () => {
    // Structural, not behavioural, and deliberately a ledger over BOTH files: the
    // defect is a class, and the two normalisation sites (the listFilesOnly
    // filter and the diagnostic-path parse) sit in different modules. A future
    // `path.sep` anywhere in either re-pins the dimension these cases exist to
    // unpin, and would do it silently on Linux.
    //
    // Comments are stripped first — both files now DISCUSS `path.sep` at length,
    // and a ledger that counted prose would be permanently red, i.e. a gate
    // everyone learns to delete.
    const stripComments = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');

    // NEGATIVE CONTROL on the instrument: the stripper must not be so eager that
    // it eats real code. Without this the assertion below is satisfied by a
    // function that returns the empty string.
    expect(stripComments('/** `path.sep` */\n// path.sep\nconst m = path.sep;')).toContain(
      'const m = path.sep;'
    );
    expect(stripComments('/** `path.sep` */\n// path.sep\nconst m = 1;')).not.toContain('path.sep');

    for (const f of ['../ci/typecheck-tests-gate.mjs', '../ci/typecheck-tests-compare.mjs']) {
      const code = stripComments(readFileSync(path.resolve(__dirname, f), 'utf8'));
      expect({ file: f, hits: code.match(/path\.sep/g) ?? [] }).toEqual({ file: f, hits: [] });
      // and the stripper genuinely read this file, rather than returning nothing
      expect(code.length).toBeGreaterThan(500);
    }
  });
});

describe('the gate, end to end: a Windows-shaped run must not read as CANNOT MEASURE', () => {
  /**
   * A wrapper stub whose `--listFilesOnly` arm answers in BACKSLASH paths. This
   * is the separator mismatch the reporter hit, mirrored: there the marker was
   * `\__tests__\` and the lines were posix; here the lines are win32 and the
   * marker (pre-fix, on this Linux host) is `/__tests__/`. Same defect, same
   * symptom, and it is reproducible on the host the suite actually runs on —
   * which is the only reason this bug is now catchable in CI at all.
   */
  function winWrapperStub(name: string, body: string) {
    const file = path.join(dir, `${name}.mjs`);
    writeFileSync(
      file,
      [
        'const args = process.argv.slice(2);',
        "if (args.includes('--listFilesOnly')) {",
        '  const lines = [];',
        // built by substitution rather than escaping, so the separator in the
        // generated file is unambiguous when read back.
        '  for (let i = 0; i < 950; i++)',
        '    lines.push(`/repo/src/x${i}/__tests__/f${i}.test.ts`.split("/").join(String.fromCharCode(92)));',
        "  console.log(lines.join('\\n'));",
        '  process.exit(0);',
        '}',
        body,
      ].join('\n')
    );
    return file;
  }

  const unchanged = [
    ...Array(5).fill(plain('src/a/__tests__/x.test.ts')),
    ...Array(2).fill(plain('src/b/__tests__/y.test.ts')),
  ];
  const emit = (lines: string[], code = 2) =>
    `console.log(${JSON.stringify(lines.join('\n'))});\nprocess.exit(${code});`;

  it('counts a BACKSLASH --listFilesOnly listing and reaches a real verdict', () => {
    const res = runGate(
      winWrapperStub('win-list', emit(unchanged)),
      fixtureBaseline('win1', BASE_FILES)
    );
    // Pre-fix this is exit 3 with "POSITIVE CONTROL FAILED … contains 0 file(s)"
    // — the reporter's exact symptom, arrived at from the other side.
    expect(res.all).not.toContain('POSITIVE CONTROL FAILED');
    expect(res.all).toContain('positive control OK — 950 test file(s)');
    expect(res.status).toBe(0);
    expect(res.all).toContain('7 error(s) across 2 file(s) (baseline: 7 across 2)');
    expect(res.all).toContain('PASS —');
  });

  it('still BLOCKS a real regression when the listing is backslash-shaped', () => {
    // The arm above proves the gate stops refusing; this proves it did not
    // start rubber-stamping. A normalisation that made everything match would
    // pass the first case and fail this one.
    const res = runGate(
      winWrapperStub('win-list-block', emit([...unchanged, plain('src/c/__tests__/z.test.ts')])),
      fixtureBaseline('win2', BASE_FILES)
    );
    expect(res.status).toBe(1);
    expect(res.all).toContain('src/c/__tests__/z.test.ts  (1)');
  });

  it('normalises BACKSLASH diagnostic paths, so they match the committed baseline keys', () => {
    // Separate arm, separate module: this one exercises `parseDiagnostics`, not
    // the listFilesOnly filter. Pre-fix on Linux the keys keep their backslashes,
    // `isGatedTestFile` rejects them as "outside src/**/__tests__/", the measured
    // total is 0, and the plausibility control refuses the run.
    const winDiag = (f: string) => plain(f.split('/').join('\\'));
    const res = runGate(
      wrapperStub(
        'win-diag',
        emit([
          ...Array(5).fill(winDiag('src/a/__tests__/x.test.ts')),
          ...Array(2).fill(winDiag('src/b/__tests__/y.test.ts')),
        ])
      ),
      fixtureBaseline('win3', BASE_FILES)
    );
    expect(res.all).not.toContain('file(s) with errors outside');
    expect(res.status).toBe(0);
    expect(res.all).toContain('7 error(s) across 2 file(s) (baseline: 7 across 2)');
    expect(res.all).toContain('PASS —');
  });
});
