import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { endpointBucketLabel } from '../analytics-bucket-labels';

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
});
