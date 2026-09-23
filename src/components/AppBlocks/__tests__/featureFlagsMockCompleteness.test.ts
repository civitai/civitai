import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A WHOLESALE `vi.mock('~/providers/FeatureFlagsProvider', …)` factory must name
 * BOTH flag hooks. Node `unit` project — the tier that EXECUTES this assertion,
 * which matters here because the failure this prevents is invisible in the browser
 * tier. Both tiers are report-only on a pull request (the node one via
 * `continue-on-error`, the browser one always, as `preview / component-tests`);
 * the node tier renders an honest verdict on a push to `main`. NEITHER TIER BLOCKS
 * A MERGE: `main` requires no status check at all in this repo, so this is a signal
 * a reviewer must read, not a door that stays shut.
 *
 * WHAT BROKE (F2). `IframeHost.tsx` began importing a component that reads
 * `useOptionalFeatureFlags` — the non-throwing variant, correct for a chrome that
 * renders outside a provider. Six sibling browser suites mocked the flags module
 * with a wholesale factory naming only `useFeatureFlags`. A wholesale factory
 * REPLACES the module, so the new named import had nothing to bind to:
 *
 *   SyntaxError: The requested module '/src/providers/FeatureFlagsProvider.tsx'
 *   does not provide an export named 'useOptionalFeatureFlags'
 *
 * 🔴 AND THE FILE THEN FAILS TO IMPORT, WHICH IS NOT THE SAME AS FAILING. Nothing
 * in it is collected, so the run reported `Test Files 6 failed` next to
 * `Tests 374 passed` — zero failing ASSERTIONS. Every instinct for reading a test
 * report (the failure count, the per-test list, "no test said FAIL") returns
 * "clean". Fixing it took the collected count from 374 to 438: those six files had
 * been contributing 64 tests that were not running at all.
 *
 * 🔴 WHY THIS IS NOT "JUST USE `importOriginal`". That is the usual cure for a
 * wholesale factory and it is WRONG for these six: the real flags module imports
 * `setTrpcBatchingEnabled` from `~/utils/trpc`, which their own wholesale trpc
 * factory does not provide, so spreading the original makes the file fail to load
 * the same way one module over. (Measured — the spread was tried first and
 * reproduced exactly that.) So the rule cannot be "never mock wholesale"; it has to
 * be "if you mock wholesale, name both hooks", which is what this checks.
 *
 * The two hooks are interchangeable from a mock's point of view — a component may
 * call either, and which one it calls is not something a test file can see — so a
 * factory naming one is a bet on today's implementation.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MODULE = '~/providers/FeatureFlagsProvider';

/**
 * 🔴 SCOPED TO `src/components/AppBlocks`, AND THE SCOPE IS A DELIBERATE DECISION
 * RATHER THAN LAZINESS. Measured repo-wide: 76 factories mock this module, 14 via an
 * `importOriginal` spread and 62 wholesale — and **52 of those 62 name only one of
 * the two hooks**. So the pattern this guard forbids is the repo's prevailing style,
 * not an anomaly, and a repo-wide version of this check would be red on 52 files
 * nobody on this change is going to fix. A permanently-red gate is worse than no
 * gate: it trains everyone to click through.
 *
 * What is in scope is the directory whose suites actually broke. Those six are fixed,
 * this keeps them fixed, and it is GREEN today. Widening it repo-wide is a real and
 * separate piece of work — it needs an owner and a decision about whether the 52 get
 * fixed or baselined — and is deliberately not smuggled in here.
 */
const SCOPE = path.join(REPO_ROOT, 'src/components/AppBlocks');

/**
 * 🔴 THIS FILE EXCLUDES ITSELF, AND MUST. It contains fixture strings that are
 * literally `vi.mock('<MODULE>', …)` factories, so a scanner that reads its own
 * source finds them, judges them, and fails — a guard failing on its own examples,
 * which is both a false positive and deeply confusing to whoever inherits it.
 */
const SELF = path.join(SCOPE, '__tests__/featureFlagsMockCompleteness.test.ts');

/** Every `.tsx`/`.ts` file under `src/`, walked directly rather than globbed —
 *  `grep -r` here honours `.gitignore` and would silently skip generated trees. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(entry.name) && p !== SELF) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Extract one whole `vi.mock('<MODULE>', …)` call starting at `at`.
 *
 * 🔴 THE WALK STARTS AT `at`, SO `vi.mock(`'s OWN PAREN OPENS THE DEPTH. Starting
 * it after the module-name string instead — which is the obvious thing to write, and
 * what this did first — means the first paren the walk meets is the FACTORY'S
 * PARAMETER LIST (`()` or `(importOriginal)`), whose `)` closes depth back to zero
 * and ends the body 46 characters in, before the factory object it is supposed to be
 * reading. Every factory then looks like it names no hooks at all, and the guard
 * reports a violation against files that are perfectly correct — which is exactly
 * what it did on its first run.
 */
function extractCall(src: string, at: number): { body: string; end: number } {
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: src.slice(at, i + 1), end: i };
    }
  }
  return { body: src.slice(at), end: src.length };
}

/** The body of every `vi.mock('<MODULE>', …)` call in `src`, paired with its file. */
function flagMockFactories(): Array<{ file: string; body: string; spread: boolean }> {
  const found: Array<{ file: string; body: string; spread: boolean }> = [];
  for (const file of walk(SCOPE)) {
    const src = fs.readFileSync(file, 'utf8');
    const needle = `vi.mock('${MODULE}'`;
    let at = src.indexOf(needle);
    while (at !== -1) {
      const { body, end } = extractCall(src, at);
      found.push({ file, body, spread: /importOriginal/.test(body) });
      at = src.indexOf(needle, end);
    }
  }
  return found;
}

describe('a wholesale FeatureFlagsProvider mock names both flag hooks', () => {
  it('the extractor captures a WHOLE factory — controls with known answers', () => {
    // 🔴 THESE ARE FIXTURES WITH KNOWN ANSWERS, NOT SHAPE HEURISTICS, AND THAT
    // DISTINCTION CAUGHT A REAL BUG IN THIS FILE. The first version of this control
    // asked only whether some extracted body "contains a newline and the string
    // useFeatureFlags" — a property a TRUNCATED body can satisfy, so it passed while
    // the extractor was cutting every factory off at its parameter list. A control
    // whose expected value is written out in full cannot pass that way.
    const arrow = `vi.mock('${MODULE}', () => ({\n  useFeatureFlags: () => ({ a: true }),\n}));`;
    expect(extractCall(arrow, 0).body).toBe(
      `vi.mock('${MODULE}', () => ({\n  useFeatureFlags: () => ({ a: true }),\n}))`
    );

    // The `importOriginal` shape, whose parameter list is the exact thing the broken
    // walk terminated on.
    const spread =
      `vi.mock('${MODULE}', async (importOriginal) => ({\n` +
      `  ...(await importOriginal()),\n  useOptionalFeatureFlags: () => ({ b: 1 }),\n}));`;
    const got = extractCall(spread, 0).body;
    expect(got).toContain('useOptionalFeatureFlags');
    expect(got.endsWith('}))')).toBe(true);

    // …and the real corpus is non-empty, so a green verdict below is a statement
    // about real files rather than about an empty set.
    const all = flagMockFactories();
    expect(
      all.length,
      'found NO `vi.mock` of the flags module under src/components/AppBlocks — the scanner is ' +
        'almost certainly broken, since six suites here are known to mock it.'
    ).toBeGreaterThanOrEqual(6);
    // Every extracted body must actually close — a truncated one silently makes the
    // hook check below meaningless for that file.
    for (const f of all) {
      expect(
        f.body.trimEnd().endsWith(')'),
        `truncated extraction in ${path.relative(REPO_ROOT, f.file)}: ${f.body.slice(0, 80)}`
      ).toBe(true);
    }
  });

  it('every wholesale factory names useFeatureFlags AND useOptionalFeatureFlags', () => {
    const wholesale = flagMockFactories().filter((f) => !f.spread);
    // The corpus under test is non-empty — otherwise this passes vacuously.
    expect(
      wholesale.length,
      'no WHOLESALE flag-module factories found; if they have all moved to `importOriginal` ' +
        'spreads this guard is obsolete rather than passing — retire it deliberately.'
    ).toBeGreaterThan(0);

    for (const { file, body } of wholesale) {
      const rel = path.relative(REPO_ROOT, file);
      for (const hook of ['useFeatureFlags', 'useOptionalFeatureFlags']) {
        expect(
          body.includes(`${hook}:`),
          `${rel}: this \`vi.mock('${MODULE}')\` factory REPLACES the module but does not name ` +
            `\`${hook}\`. The day anything in this file's module graph imports it, the file will ` +
            `fail to IMPORT — collecting ZERO tests and reporting ZERO failures, which reads as ` +
            `a pass. Add \`${hook}: () => (<same flags>),\` to the factory. (An \`importOriginal\` ` +
            `spread is the usual cure but is NOT always available here — see this guard's header.)`
        ).toBe(true);
      }
    }
  });
});
