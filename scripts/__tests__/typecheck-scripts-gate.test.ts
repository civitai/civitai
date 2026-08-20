import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOW_EMPTY_ENV,
  FALLBACK_MIN_SCRIPT_FILES,
  countScriptFilesInProgram,
  diffLists,
  isGatedScriptFile,
  isScriptFileLine,
  relativizeToRepo,
  scriptFileFloor,
  stripJsonComments,
} from '../ci/typecheck-scripts-compare.mjs';

/**
 * `scripts/ci/typecheck-scripts-gate.mjs` measures the type errors in the part of
 * `scripts/` the root program excludes — `scripts/__tests__/**` and
 * `scripts/local-dev/gen_seed.ts`. It is not wired into CI (see its header for
 * why), so its exit code is a report rather than a merge block. Its entire value
 * rests on one property: it must be UNABLE to report a confident zero.
 *
 * Two tiers here, deliberately:
 *
 *  - the pure functions THIS gate adds (path anchoring, the positive control's
 *    counter and floor, the config-drift diff), driven directly. The generic
 *    half — parsing, run classification, plausibility, the ratchet comparison —
 *    is imported from `typecheck-tests-compare.mjs` and is already covered by
 *    `typecheck-tests-gate.test.ts`; re-testing it here would assert the same
 *    code twice and drift.
 *  - the gate END TO END, driven through the `TYPECHECK_SCRIPTS_WRAPPER` seam
 *    with stub "typecheckers" that exit the way each real failure does. A real
 *    repo-wide `tsc` run is minutes, so nobody would run one per case — and a
 *    control nobody runs is not a control.
 *
 * Every end-to-end case asserts a NON-ZERO exit AND a message naming the real
 * problem. A test that only asserted "it did not pass" would still be satisfied
 * by a gate that fails for the wrong reason.
 */

const GATE = path.resolve(__dirname, '../ci/typecheck-scripts-gate.mjs');

// Built by concatenation so this file's own source can never be mistaken for a
// diagnostic by the parser it is testing.
const TS = `error${' '}TS`;
const plain = (file: string, code = 2322) =>
  `${file}(1,1): ${TS}${code}: Type 'string' is not assignable to type 'number'.`;

// The quarantine the gate pins. Mirrored here so a drift between the gate's list
// and the fixtures shows up as a failing test rather than as a silent no-op.
// What `tsconfig.json` excludes and `tsconfig.scripts.json` re-includes. Mirrored
// here so a drift between the gate's list and these fixtures fails a test rather
// than silently becoming a no-op.
const QUARANTINE = ['scripts/__tests__/**', 'scripts/local-dev/gen_seed.ts'];
const BASE_EXCLUDE = ['node_modules', 'src/**/__tests__/**', 'packages/civitai-ui'];

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'typecheck-scripts-gate-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

/**
 * A stub that answers the `--listFilesOnly` arm and the verdict arm differently,
 * which is what the real wrapper does. Without this the positive control and the
 * verdict would see the same text.
 */
function twoArmWrapper(listOut: string, listCode: number, verdictOut: string, verdictCode: number) {
  const file = path.join(dir, `stub-two-${seq++}.mjs`);
  writeFileSync(
    file,
    `const listOnly = process.argv.includes('--listFilesOnly');\n` +
      `process.stdout.write(listOnly ? ${JSON.stringify(listOut)} : ${JSON.stringify(
        verdictOut
      )});\n` +
      `process.exit(listOnly ? ${listCode} : ${verdictCode});\n`
  );
  return file;
}

function writeConfigs(where: string, baseExclude: string[], scriptsExclude: string[]) {
  mkdirSync(where, { recursive: true });
  writeFileSync(
    path.join(where, 'tsconfig.json'),
    JSON.stringify({ include: ['scripts/**/*.ts', 'src'], exclude: baseExclude }, null, 2)
  );
  writeFileSync(
    path.join(where, 'tsconfig.scripts.json'),
    JSON.stringify({ extends: './tsconfig.json', exclude: scriptsExclude }, null, 2)
  );
}

function writeBaselineFile(
  where: string,
  files: Record<string, number>,
  scriptFilesInProgram = 34
) {
  const p = path.join(dir, `baseline-${seq++}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      config: 'tsconfig.scripts.json',
      scriptFilesInProgram,
      totalErrors: Object.values(files).reduce((a, b) => a + b, 0),
      files,
    })
  );
  return p;
}

/** A `--listFilesOnly` payload naming `n` distinct files under `<root>/scripts/`. */
function listing(root: string, n: number) {
  return Array.from({ length: n }, (_, i) => `${root}/scripts/gen/file-${i}.ts`).join('\n');
}

function runGate(env: Record<string, string>) {
  const res = spawnSync(process.execPath, [GATE], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { ...res, output: `${res.stdout || ''}${res.stderr || ''}` };
}

// ------------------------------------------------------- path anchoring

describe('relativizeToRepo', () => {
  it('strips the repo root', () => {
    expect(relativizeToRepo('/repo/scripts/a.ts', '/repo')).toBe('scripts/a.ts');
  });

  it('tolerates a trailing slash on the root', () => {
    expect(relativizeToRepo('/repo/scripts/a.ts', '/repo/')).toBe('scripts/a.ts');
  });

  it('returns null for a path outside the repo', () => {
    expect(relativizeToRepo('/elsewhere/scripts/a.ts', '/repo')).toBeNull();
  });

  it('does NOT treat a sibling directory sharing the root prefix as inside it', () => {
    // `/repo-worktree` starts with `/repo`. Without the trailing separator this
    // returns `worktree/scripts/a.ts`, which then matches nothing and is merely
    // wrong; with a `scripts/` at the front it would be COUNTED as ours.
    expect(relativizeToRepo('/repo-worktree/scripts/a.ts', '/repo')).toBeNull();
  });

  it('normalises backslashes so a win32-shaped path lands in the same space', () => {
    expect(relativizeToRepo('C:\\repo\\scripts\\a.ts', 'C:\\repo')).toBe('scripts/a.ts');
  });
});

describe('isScriptFileLine — the positive control must not be walkable by a substring', () => {
  const ROOT = '/repo';

  it('counts a file under the repo-root scripts/ directory', () => {
    expect(isScriptFileLine(`${ROOT}/scripts/oneoffs/x.ts`, ROOT)).toBe(true);
  });

  it('does NOT count .claude/skills/**/scripts/, which this repo really does pull in', () => {
    // Five of these are in the real program as transitive imports. A
    // `p.includes('/scripts/')` control counts them, and could therefore stay
    // green with the entire repo-root scripts/ tree gone. This is the assertion
    // that makes the control a control.
    expect(isScriptFileLine(`${ROOT}/.claude/skills/dev-server/scripts/daemon.mjs`, ROOT)).toBe(
      false
    );
  });

  it('does NOT count a vendored package that happens to have a scripts/ directory', () => {
    expect(isScriptFileLine(`${ROOT}/node_modules/whatever/scripts/build.ts`, ROOT)).toBe(false);
  });

  it('does NOT count src/', () => {
    expect(isScriptFileLine(`${ROOT}/src/server/a.ts`, ROOT)).toBe(false);
  });

  it('counts nothing at all when the root does not match — a wrong root reads as zero, not as noise', () => {
    expect(countScriptFilesInProgram(listing('/repo', 40), '/somewhere-else')).toBe(0);
  });

  it('counts every scripts/ line under the right root', () => {
    expect(countScriptFilesInProgram(listing('/repo', 40), '/repo')).toBe(40);
  });
});

describe('isGatedScriptFile', () => {
  it('claims files under scripts/', () => {
    expect(isGatedScriptFile('scripts/local-dev/gen_seed.ts')).toBe(true);
  });
  it('does not claim src/ — those belong to `pnpm typecheck`', () => {
    expect(isGatedScriptFile('src/server/a.ts')).toBe(false);
  });
  it('does not claim a path merely CONTAINING scripts/', () => {
    expect(isGatedScriptFile('.claude/skills/dev-server/scripts/daemon.mjs')).toBe(false);
  });
});

// ------------------------------------------------------------- the floor

describe('scriptFileFloor', () => {
  it('falls back to the fixed floor when the baseline records nothing', () => {
    expect(scriptFileFloor(undefined)).toMatchObject({
      ok: true,
      floor: FALLBACK_MIN_SCRIPT_FILES,
      derived: false,
    });
  });

  it('derives 90% of the recorded count when that RAISES the fixed floor', () => {
    expect(scriptFileFloor(100)).toMatchObject({ ok: true, floor: 90, derived: true });
  });

  it('never lets a derived floor LOWER the fixed one', () => {
    // The defect this guards: `scriptFileFloor(1)` returning `{floor: 0}` — a
    // floor no program can fail — while still reporting `derived: true`, i.e.
    // while logging that it was derived and therefore trustworthy.
    expect(scriptFileFloor(2)).toMatchObject({
      ok: true,
      floor: FALLBACK_MIN_SCRIPT_FILES,
      derived: false,
    });
  });

  it('REFUSES a zero or negative recorded count rather than falling back', () => {
    // A corrupt count is not the same as an ABSENT one; quietly treating it as
    // absent is how a broken baseline reads as a working control.
    expect(scriptFileFloor(0).ok).toBe(false);
    expect(scriptFileFloor(-5).ok).toBe(false);
  });

  it('REFUSES a non-integer recorded count', () => {
    expect(scriptFileFloor('34' as unknown as number).ok).toBe(false);
    expect(scriptFileFloor(3.5).ok).toBe(false);
  });

  it('REFUSES an absurd count, which would make the control permanently red', () => {
    expect(scriptFileFloor(10_000_000).ok).toBe(false);
  });
});

// ------------------------------------------------------- config drift

describe('diffLists', () => {
  it('accepts the base list minus exactly the expected set', () => {
    const base = [...BASE_EXCLUDE, ...QUARANTINE];
    expect(diffLists(base, BASE_EXCLUDE, QUARANTINE).ok).toBe(true);
  });

  it('ignores ORDER — a cosmetic reshuffle must not read as drift', () => {
    const base = [...QUARANTINE, ...BASE_EXCLUDE];
    expect(diffLists(base, [...BASE_EXCLUDE].reverse(), QUARANTINE).ok).toBe(true);
  });

  it('REJECTS when the variant still excludes a quarantined entry', () => {
    // i.e. the measurement program is NOT measuring the file it claims to.
    const base = [...BASE_EXCLUDE, ...QUARANTINE];
    const variant = [...BASE_EXCLUDE, QUARANTINE[0]!];
    const d = diffLists(base, variant, QUARANTINE);
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual([QUARANTINE[0]]);
  });

  it('REJECTS when the variant drops something NOT in the quarantine', () => {
    // This is the silent-widening case: the measurement program quietly stops
    // excluding `src/**/__tests__/**` and the number starts meaning something
    // else entirely.
    const base = [...BASE_EXCLUDE, ...QUARANTINE];
    const variant = base.filter((e) => e !== 'src/**/__tests__/**' && !QUARANTINE.includes(e));
    const d = diffLists(base, variant, QUARANTINE);
    expect(d.ok).toBe(false);
    expect(d.unexpected).toContain('src/**/__tests__/**');
  });

  it('REJECTS when the variant ADDS an exclude of its own', () => {
    const base = [...BASE_EXCLUDE, ...QUARANTINE];
    const d = diffLists(base, [...BASE_EXCLUDE, 'scripts/**'], QUARANTINE);
    expect(d.ok).toBe(false);
    expect(d.added).toEqual(['scripts/**']);
  });

  it('REJECTS a STALE quarantine list — a file cleaned up in the configs but left in the gate', () => {
    // The direction this gate is meant to move in. If someone removes an entry
    // from both configs but forgets the gate's own list, the gate must refuse
    // rather than measure a program it has the wrong model of.
    const shrunk = QUARANTINE.slice(1);
    const base = [...BASE_EXCLUDE, ...shrunk];
    const d = diffLists(base, BASE_EXCLUDE, QUARANTINE);
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual([QUARANTINE[0]]);
  });
});

// --------------------------------------------------------------- end to end

describe('the gate, end to end', () => {
  /** Configs that satisfy the drift control, so other controls are reachable. */
  function okConfigDir() {
    const where = path.join(dir, `cfg-${seq++}`);
    writeConfigs(where, [...BASE_EXCLUDE, ...QUARANTINE], BASE_EXCLUDE);
    return where;
  }

  const ROOT = '/fixture-root';
  const goodListing = listing(ROOT, 34);

  it('PASSES when the measurement equals the baseline', () => {
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 2 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(
        goodListing,
        0,
        [plain('scripts/a.ts'), plain('scripts/a.ts')].join('\n'),
        1
      ),
    });
    expect(res.status).toBe(0);
    expect(res.output).toContain('PASS');
  });

  it('BLOCKS a worsened baselined file, naming the delta', () => {
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 2 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(
        goodListing,
        0,
        [plain('scripts/a.ts'), plain('scripts/a.ts'), plain('scripts/a.ts')].join('\n'),
        1
      ),
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain('BLOCKED');
    expect(res.output).toContain('scripts/a.ts  2 -> 3');
  });

  it('BLOCKS a file with errors that is not in the baseline', () => {
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 2 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(
        goodListing,
        0,
        [plain('scripts/a.ts'), plain('scripts/a.ts'), plain('scripts/new.ts')].join('\n'),
        1
      ),
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain('are NOT in the baseline');
    expect(res.output).toContain('scripts/new.ts');
  });

  it('PASSES and SAYS SO when a baselined file is fixed', () => {
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 8, 'scripts/b.ts': 4 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(
        goodListing,
        0,
        Array.from({ length: 8 }, () => plain('scripts/a.ts')).join('\n'),
        1
      ),
    });
    expect(res.status).toBe(0);
    expect(res.output).toContain('1 file(s) now clean');
  });

  it('does NOT claim errors outside scripts/, but reports them', () => {
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 1 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(
        goodListing,
        0,
        [plain('scripts/a.ts'), plain('src/server/x.ts')].join('\n'),
        1
      ),
    });
    // `src/server/x.ts` must not be scored as a newly-dirty file of this gate's.
    expect(res.status).toBe(0);
    expect(res.output).toContain('outside scripts/');
    expect(res.output).toContain('src/server/x.ts');
  });

  // ---- the controls, each proven able to go red -------------------------

  it('CANNOT MEASURE when the positive control finds too few scripts/ files', () => {
    // The whole point: a program that has lost the tree reports every file as
    // `fixed`, i.e. PASS, unless something refuses first.
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 2 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(listing(ROOT, 3), 0, '', 0),
    });
    expect(res.status).toBe(3);
    expect(res.output).toContain('POSITIVE CONTROL FAILED');
    expect(res.output).toContain('below the floor of 30');
  });

  it('CANNOT MEASURE when the config-drift control fails', () => {
    const where = path.join(dir, `cfg-drift-${seq++}`);
    // The variant still excludes a quarantined file, so it is not measuring it.
    writeConfigs(where, [...BASE_EXCLUDE, ...QUARANTINE], [...BASE_EXCLUDE, QUARANTINE[0]!]);
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: where,
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 2 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(goodListing, 0, plain('scripts/a.ts'), 1),
    });
    expect(res.status).toBe(3);
    expect(res.output).toContain('no longer');
    expect(res.output).toContain(QUARANTINE[0]!);
  });

  it('CANNOT MEASURE on a non-zero exit with zero diagnostics — the heap-abort shape', () => {
    // exit 134 with no output is what a V8 heap abort looks like. Read as
    // "clean", it is the single most dangerous false green available.
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 2 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(goodListing, 0, '', 134),
    });
    expect(res.status).toBe(3);
    expect(res.output).toContain('FAILURE TO RUN');
  });

  it('CANNOT MEASURE when the verdict run parses 0 against a non-zero baseline', () => {
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 198 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(goodListing, 0, '', 0),
    });
    expect(res.status).toBe(3);
    expect(res.output).toContain('parsed 0');
  });

  it('SHOUTS but still runs on a collapsed verdict measurement', () => {
    // A collapse cannot hide a regression, so refusing would block a legitimate
    // large cleanup for no safety gain. It must be loud, not fatal.
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 198 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(goodListing, 0, plain('scripts/a.ts'), 1),
    });
    expect(res.status).toBe(0);
    expect(res.output).toContain('IMPLAUSIBLE MEASUREMENT');
  });

  it('REFUSES the plausibility escape hatch on a verdict run', () => {
    // Refused rather than ignored: silently ignoring a control-disabling
    // variable is its own confident-wrong.
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 2 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(goodListing, 0, '', 0),
      [ALLOW_EMPTY_ENV]: 'the tree is genuinely clean now',
    });
    expect(res.status).toBe(3);
    expect(res.output).toContain('REFUSING TO RUN');
    // It must name ITS OWN variable, not the sibling gate's — the whole reason
    // `classifyEmptyAllowance` takes an `envName`.
    expect(res.output).toContain('TYPECHECK_SCRIPTS_ALLOW_EMPTY');
    expect(res.output).not.toContain('TYPECHECK_TESTS_ALLOW_EMPTY');
  });

  it('ECHOES overridden seams, so a stub-driven run is not byte-identical to a real one', () => {
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: writeBaselineFile(dir, { 'scripts/a.ts': 1 }),
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(goodListing, 0, plain('scripts/a.ts'), 1),
    });
    expect(res.output).toContain('[OVERRIDE]');
    expect(res.output).toContain('seam(s) overridden by environment');
  });

  it('refuses a baseline whose totalErrors disagrees with its entries', () => {
    const p = path.join(dir, `baseline-bad-${seq++}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        config: 'tsconfig.scripts.json',
        scriptFilesInProgram: 34,
        totalErrors: 198,
        files: { 'scripts/a.ts': 5 },
      })
    );
    const res = runGate({
      TYPECHECK_SCRIPTS_CONFIG_DIR: okConfigDir(),
      TYPECHECK_SCRIPTS_PROGRAM_ROOT: ROOT,
      TYPECHECK_SCRIPTS_BASELINE: p,
      TYPECHECK_SCRIPTS_WRAPPER: twoArmWrapper(goodListing, 0, plain('scripts/a.ts'), 1),
    });
    expect(res.status).toBe(2);
    expect(res.output).toContain('unusable baseline');
  });
});

// ------------------------------------------- the committed baseline itself

describe('the committed baseline', () => {
  it('is internally consistent and measured against the right config', () => {
    const p = path.resolve(__dirname, '../ci/typecheck-scripts-baseline.json');
    const b = JSON.parse(readFileSync(p, 'utf8'));
    expect(b.config).toBe('tsconfig.scripts.json');
    const sum = Object.values(b.files as Record<string, number>).reduce((a, c) => a + c, 0);
    expect(b.totalErrors).toBe(sum);
    expect(Number.isInteger(b.scriptFilesInProgram)).toBe(true);
    expect(b.scriptFilesInProgram).toBeGreaterThan(FALLBACK_MIN_SCRIPT_FILES);
  });

  it('names only files this gate is responsible for', () => {
    const p = path.resolve(__dirname, '../ci/typecheck-scripts-baseline.json');
    const b = JSON.parse(readFileSync(p, 'utf8'));
    for (const file of Object.keys(b.files)) expect(isGatedScriptFile(file)).toBe(true);
  });

  it('records ONLY files the root program excludes — never one `pnpm typecheck` can see', () => {
    // 🔴 The invariant that keeps this baseline from becoming a place to hide a
    // real failure. Every entry must be a path `tsconfig.json` excludes. An entry
    // for a root-COVERED file would mean somebody recorded an error that the root
    // typecheck is red on — i.e. used this file to make a blocking failure look
    // handled. That is the one way this instrument could do harm, so it is pinned
    // structurally rather than trusted to review.
    //
    // The exclusion set is read from `tsconfig.json` rather than restated, so
    // narrowing the exclusions automatically tightens this test.
    const root = path.resolve(__dirname, '../..');
    const excludes: string[] = JSON.parse(
      stripJsonComments(readFileSync(path.join(root, 'tsconfig.json'), 'utf8'))
    ).exclude;
    const scriptExcludes = excludes.filter((e) => e.startsWith('scripts/'));

    // Positive control on the parse itself: a zero here would make the loop below
    // vacuous, and a vacuous loop passes.
    expect(scriptExcludes.length).toBeGreaterThan(0);

    const covers = (file: string) =>
      scriptExcludes.some((pattern) =>
        pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern
      );

    const b = JSON.parse(
      readFileSync(path.resolve(__dirname, '../ci/typecheck-scripts-baseline.json'), 'utf8')
    );
    const entries = Object.keys(b.files);
    expect(entries.length).toBeGreaterThan(0);
    for (const file of entries) {
      expect(
        covers(file),
        `${file} is in the baseline but is NOT excluded by tsconfig.json, so the root ` +
          `typecheck can see it. Fix the file; do not record it here.`
      ).toBe(true);
    }
  });

  it('the covers() predicate can actually reject — negative control', () => {
    // Without this, the loop above would pass just as happily against a predicate
    // that returns true for everything.
    const scriptExcludes = ['scripts/__tests__/**', 'scripts/local-dev/gen_seed.ts'];
    const covers = (file: string) =>
      scriptExcludes.some((pattern) =>
        pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern
      );
    expect(covers('scripts/__tests__/anything.test.ts')).toBe(true);
    expect(covers('scripts/local-dev/gen_seed.ts')).toBe(true);
    // Root-covered paths — a baseline entry for any of these must fail the test above.
    expect(covers('scripts/oneoffs/parse_header.ts')).toBe(false);
    expect(covers('scripts/local-dev/utils.ts')).toBe(false);
    expect(covers('scripts/seed-comics.ts')).toBe(false);
  });
});
