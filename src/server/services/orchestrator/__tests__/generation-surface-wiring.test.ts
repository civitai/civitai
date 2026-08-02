import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { GENERATION_SURFACES } from '~/shared/data-graph/generation/model-substitution';

/**
 * 🔴 POPULATION GUARD for the `surface` label of
 * `civitai_generation_model_substitutions_total` (issue #3520).
 *
 * `validateInput` is the single choke point every SERVER-side
 * `generationGraph.safeParse` runs through, and it structurally cannot tell which
 * caller it is serving. The surface therefore has to be fixed by whoever builds
 * the request's context — `buildGenerationContext(userTier, flags, user, surface)`
 * — and the guarantee this test protects is that EVERY such call site does so,
 * with the surface that matches what that call site actually is.
 *
 * WHY A SOURCE-LEVEL GUARD AND NOT ONLY BEHAVIOURAL TESTS. The behavioural tests
 * exist too (the App Blocks bridge in `blocks.router.workflow.test.ts`, preset
 * generation in `preset-image-gen.surface.test.ts`), but each of those can only
 * cover a call site that ALREADY EXISTS. The failure this signal is most exposed
 * to is a SIXTH entry point added later and labelled with whatever surface was
 * nearest to hand — which silently contaminates exactly the number phase 3's
 * policy decision is gated on. That is a claim about the population, so it is
 * checked against the population: every occurrence in `src/`, enumerated from the
 * tree rather than from a list someone maintains.
 *
 * TypeScript already forces the argument to EXIST (it is required, not
 * defaulted). What it cannot check is that the value is the RIGHT one for that
 * file, which is what the expected-by-path table below pins.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/**
 * Every file allowed to build a generation context, and the surface it must
 * declare. Adding a generation entry point means adding a row here — a
 * deliberate, reviewable act, rather than a silent widening.
 */
const EXPECTED_SURFACE_BY_FILE: Record<string, string> = {
  // The on-site generator. #3520 calls this substitution CORRECT: the only way
  // the form holds an out-of-list id is a stale localStorage value after an
  // ecosystem switch, and the user visibly sees the picker snap back.
  'src/server/routers/orchestrator.router.ts': 'onsite',
  // The App Blocks bridge — the surface the issue is about. The id was written
  // by an app author and the correction was unobservable.
  'src/server/routers/blocks.router.ts': 'block',
  // Comics / preset image generation: server-composed graph input.
  'src/server/services/orchestrator/preset-image-gen.service.ts': 'preset',
};

/**
 * Blank out comments so a doc-comment that MENTIONS `buildGenerationContext(...)`
 * is not mistaken for a call site. Whitespace-preserving, so offsets are stable.
 * Deliberately simple: it only has to be right about this repo's own source, and
 * it can only ever produce a FALSE ALARM (a real call hidden), never a false pass.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** Enumerate call sites from the TREE, not from a hand-kept list. */
function findCallSiteFiles(): string[] {
  const out = execFileSync(
    'grep',
    ['-rl', '--include=*.ts', '--include=*.tsx', 'buildGenerationContext(', 'src'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (f) =>
        // The definition itself, and tests, are not call sites.
        f !== 'src/server/services/orchestrator/orchestration-new.service.ts' &&
        !f.includes('__tests__') &&
        !f.endsWith('.test.ts')
    )
    .filter(
      (f) =>
        argumentListsOf(
          stripComments(readFileSync(path.join(REPO_ROOT, f), 'utf8')),
          'buildGenerationContext('
        ).length > 0
    );
}

/**
 * The argument list of every `<needle>` call in `source`, extracted by BALANCED
 * PARENTHESES rather than by a line pattern — a formatter reflow (prettier
 * collapsing a multi-line call, or the reverse) must not be able to make this
 * guard silently inspect the wrong text and pass.
 */
function argumentListsOf(source: string, needle: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    let depth = 1;
    let i = at + needle.length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
    }
    out.push(source.slice(at + needle.length, i - 1));
    from = i;
  }
  return out;
}

describe('generation-context surface wiring', () => {
  const files = findCallSiteFiles();

  it('finds the call sites at all (guard the guard)', () => {
    // Without this, a broken enumeration would make every assertion below pass
    // vacuously over an empty list.
    expect(files.length).toBeGreaterThanOrEqual(Object.keys(EXPECTED_SURFACE_BY_FILE).length);
  });

  it('every file that builds a generation context is a KNOWN surface', () => {
    const unexpected = files.filter((f) => !(f in EXPECTED_SURFACE_BY_FILE));
    // A new generation entry point must declare which population it belongs to;
    // inheriting a neighbour's surface silently contaminates the number that
    // gates the phase-3 policy decision.
    expect(unexpected).toEqual([]);
  });

  it.each(Object.entries(EXPECTED_SURFACE_BY_FILE))(
    '%s passes the surface %s at EVERY buildGenerationContext call',
    (file, expectedSurface) => {
      const source = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      const calls = argumentListsOf(source, 'buildGenerationContext(');
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        const found = GENERATION_SURFACES.filter((s) => args.includes(`'${s}'`));
        // Exactly one surface literal, and it is this file's.
        expect(found).toEqual([expectedSurface]);
      }
    }
  );

  it('the expectation table covers every declared surface (no orphan label)', () => {
    // A surface value with no call site would be a series that can never be
    // emitted — an alert keyed on it would then be structurally silent, which is
    // the exact failure class this counter exists to avoid.
    expect([...new Set(Object.values(EXPECTED_SURFACE_BY_FILE))].sort()).toEqual(
      [...GENERATION_SURFACES].sort()
    );
  });
});
