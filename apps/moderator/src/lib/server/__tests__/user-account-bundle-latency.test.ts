import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 SOURCE-LEVEL. A `Promise.all` is only as fast as its slowest member, and nothing observable at
 * runtime distinguishes "this endpoint got slow" from "this endpoint was always slow".
 *
 * `/api/user-account` fans out to ten list queries that each resolve in about a second. Two reads do
 * not belong in it, and both were in it:
 *
 *   `getReactionTargets` aggregates EVERY reaction an account has ever given, with no time bound.
 *   Measured on production: 46,744 reactions across 2,058 creators takes 1.9s; 820,263 across 7,131
 *   takes 20s. 317 accounts are over 100k, and they are disproportionately the accounts a farming
 *   investigation looks up. There is no statement_timeout on the pool, so it does not fail — it waits,
 *   and every other panel on the page waits with it. Reported by a moderator as the reactions panel
 *   "failing to load and showing as empty".
 *
 *   `getBuzzBalance` is three external HTTP calls to the Buzz service.
 *
 * Folding either back in is free to write, breaks no test that runs, and silently restores a
 * twenty-second page for the accounts that matter most. Hence a guard that reads the source.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '../../..'); // src/
const read = (p: string) => readFileSync(join(APP, p), 'utf8');

const BUNDLE = 'routes/api/user-account/[userId]/+server.ts';

/** Reads named imports out of the endpoint, so a call added without an import cannot pass either. */
const bundleSource = () => read(BUNDLE);

describe('the /api/user-account bundle', () => {
  it('does not fan out to the unbounded reaction aggregate', () => {
    expect(bundleSource()).not.toContain('getReactionTargets');
  });

  it('does not fan out to the Buzz service', () => {
    expect(bundleSource()).not.toContain('getBuzzBalance');
  });

  it('still fans out to the list queries it exists for', () => {
    // The negative assertions above are satisfied by an empty file. This is what stops the guard
    // passing over an endpoint someone gutted.
    const source = bundleSource();
    for (const fn of ['getReviews', 'getComments', 'getCosmetics', 'getShopPurchases'])
      expect(source).toContain(fn);
  });
});

describe('the two reads that were pulled out', () => {
  it('each have an endpoint of their own', () => {
    // Without these the "not in the bundle" assertions above are also satisfied by deleting the
    // feature, which is the other way to make a slow panel fast.
    expect(read('routes/api/user-reactions/[userId]/+server.ts')).toContain('getReactionTargets');
    expect(read('routes/api/user-buzz-balance/[userId]/+server.ts')).toContain('getBuzzBalance');
  });

  it('are gated on the page that serves them', () => {
    for (const route of [
      'routes/api/user-reactions/[userId]/+server.ts',
      'routes/api/user-buzz-balance/[userId]/+server.ts',
    ]) {
      const source = read(route);
      expect(source).toContain('requireUserIdParam');
      expect(source).toContain('/retool/user-lookup');
    }
  });
});
