import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { endpointBucketLabel, scopeBucketLabel } from '../analytics-bucket-labels';

/**
 * Drift guard: every bounded `endpoint` literal the server writes to
 * `block_scope_invocations` MUST have a label, or it renders as a raw internal token in
 * the analytics panel's "Top endpoints" card.
 *
 * An earlier revision of this suite hardcoded the four strings and a comment claiming it
 * was "the reminder to add one" — which is not a gate at all: a fifth `endpoint:` literal
 * in the router would leave it green. This greps the SOURCE OF TRUTH instead (mirrors
 * `block-scope.schema-drift.test.ts`).
 *
 * Scope of the grep, and why it is the right set:
 *   - Only the two ROUTER files write bounded string literals. The other
 *     `recordScopeInvocation` writers are `block-scope.middleware.ts`, which writes
 *     `normalizeEndpoint(req.url)` (a REST path — deliberately passed through), and
 *     `oauth-scope-audit.ts`, which writes dotted tRPC paths on rows carrying no
 *     `appBlockId` and so cannot reach this rollup (`topEndpoints` filters
 *     `appBlockId: { in: ownedIds }`).
 *   - Single-quoted literals only. A template literal is by definition not a bounded
 *     token, and #3561's whole point was that there should not be any.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WRITER_FILES = ['src/server/routers/blocks.router.ts', 'src/server/routers/apps.router.ts'];

/** Repo-relative paths of files under `dir` whose contents match `re`. */
function grepFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(child);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        if (re.test(readFileSync(child, 'utf8'))) {
          out.push(path.relative(REPO_ROOT, child));
        }
      }
    }
  };
  walk(path.join(REPO_ROOT, dir));
  return out;
}

function boundedEndpointLiterals(): string[] {
  const found = new Set<string>();
  for (const rel of WRITER_FILES) {
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const m of src.matchAll(/endpoint: '([^']+)'/g)) found.add(m[1]);
  }
  return [...found].sort();
}

describe('endpoint label map ⇄ server writers drift guard', () => {
  it('the grep finds a plausible number of literals (positive control)', () => {
    // If the source moves or the pattern rots, this catches it BEFORE the set
    // comparison below reads as a vacuous pass on an empty set.
    const literals = boundedEndpointLiterals();
    expect(literals.length).toBeGreaterThanOrEqual(4);
    expect(literals).toContain('workflow:submit');
  });

  it('every bounded endpoint literal the server writes has a label', () => {
    const unlabelled = boundedEndpointLiterals().filter(
      (e) => endpointBucketLabel(e) === e // fell through to raw pass-through
    );
    expect(unlabelled).toEqual([]);
  });

  it('pins the exact current set, so ADDING a writer is a deliberate act', () => {
    expect(boundedEndpointLiterals()).toEqual([
      'storage:delete',
      'storage:set',
      'user-settings:write',
      'workflow:submit',
    ]);
  });

  /**
   * 🔴 And pin the WRITER FILES, not just the literals. The list above is scoped to two
   * router files, justified by the fact that the only other `recordScopeInvocation`
   * callers write a `normalizeEndpoint` REST path or rows with no `appBlockId`. But that
   * justification is a fact about today: a THIRD file calling `recordScopeInvocation`
   * with a new bounded literal would leave every test above green and render raw. So
   * gate the file set too.
   */
  it('no unexpected file calls recordScopeInvocation with a bounded literal', () => {
    const callers = readFileSync(
      path.join(REPO_ROOT, 'src/server/services/blocks/user-app-surface.service.ts'),
      'utf8'
    );
    // Sanity that we are reading the right module (positive control for this test).
    expect(callers).toContain('recordScopeInvocation');

    const KNOWN_WRITERS = [
      ...WRITER_FILES,
      'src/server/middleware/block-scope.middleware.ts', // normalizeEndpoint REST paths
      'src/server/services/oauth/oauth-scope-audit.ts', // no appBlockId -> excluded
    ].sort();
    const found = grepFiles('src/server', /recordScopeInvocation\(\{/).sort();
    expect(found).toEqual(KNOWN_WRITERS);
  });
});

/**
 * Drift guard for the SCOPES card. The absence of this guard is exactly why two live
 * scopes (`collections:write:self`, `apps:storage:shared:write`) shipped unlabelled in the
 * first cut of `scopeBucketLabel`: the endpoint half was gated and the scope half was not,
 * so adding a `requiredScope` to a route could never fail a test.
 *
 * Source of truth for what lands in `block_scope_invocations.scope`:
 *   - `withBlockScope(..., { requiredScope: '<literal>' })` on the REST routes — the
 *     middleware writes it verbatim;
 *   - the `scope: '<literal>'` arguments at the routers' recordScopeInvocation sites;
 *   - the middleware's `'(any-token)'` default for a route requiring no particular scope.
 */
describe('scope label map ⇄ server writers drift guard', () => {
  function writtenScopes(): string[] {
    const found = new Set<string>(['(any-token)']);
    for (const rel of grepFiles('src/pages/api', /requiredScope: '([^']+)'/)) {
      const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const m of src.matchAll(/requiredScope: '([^']+)'/g)) found.add(m[1]);
    }
    for (const rel of WRITER_FILES) {
      const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const m of src.matchAll(/scope: '([^']+)'/g)) found.add(m[1]);
    }
    return [...found].sort();
  }

  it('the grep finds a plausible number of scopes (positive control)', () => {
    const scopes = writtenScopes();
    expect(scopes.length).toBeGreaterThanOrEqual(8);
    expect(scopes).toContain('ai:write:budgeted');
    expect(scopes).toContain('apps:storage:shared:write');
  });

  it('every scope the server can write has a label', () => {
    const unlabelled = writtenScopes().filter((s) => scopeBucketLabel(s) === s);
    // `publisher_all_my_models` is an ATTRIBUTION scope (block_user_subscriptions), not a
    // block_scope_invocations value, so it never reaches this card and needs no label.
    expect(unlabelled).toEqual(['publisher_all_my_models']);
  });
});
