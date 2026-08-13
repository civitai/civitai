import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper module, no types; `scripts/` is outside every tsconfig program.
import {
  checkPlausibility,
  classifyRun,
  compare,
  detectRenames,
  diffExcludes,
  isGatedTestFile,
  parseDiagnostics,
  stripJsonComments,
  testFileFloor,
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
    expect(v.reason).toMatch(/blind to this output/);
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
  it('allows any non-zero measurement', () => {
    expect(checkPlausibility({ currentTotal: 1, baselineTotal: 801 }).ok).toBe(true);
  });
});

describe('testFileFloor', () => {
  it('derives the floor from the baseline count rather than a magic number', () => {
    expect(testFileFloor(938)).toEqual({ floor: 844, derived: true });
  });
  it.each([[undefined], [0], [-1], ['938'], [1.5]])(
    'falls back when the baseline records %p',
    (v) => {
      expect(testFileFloor(v as never)).toEqual({ floor: 400, derived: false });
    }
  );
  it('would have caught the shrink the old fixed floor allowed', () => {
    // 938 real files, old floor 400: 57% of the tree could leave and the control
    // stayed green, with the vanished files scored `fixed` -> PASS.
    const { floor } = testFileFloor(938);
    expect(400).toBeLessThan(floor);
    expect(500 < floor).toBe(true);
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

  it('…and passes that same zero behind the explicit escape hatch', () => {
    const res = runGate(
      wrapperStub('clean2', 'process.exit(0);'),
      fixtureBaseline('b4', BASE_FILES),
      [],
      {
        TYPECHECK_TESTS_ALLOW_EMPTY: '1',
      }
    );
    expect(res.status).toBe(0);
    expect(res.all).toContain('PASS —');
  });

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
