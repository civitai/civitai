import { describe, expect, it, vi } from 'vitest';

/**
 * WHO BELONGS IN THE USER SEARCH INDEX.
 *
 * A banned account must not be discoverable through user search. Two independent halves have
 * to agree for that to hold, and a bug in either one alone is enough to put a banned account
 * back in front of users:
 *
 *   - the WRITE side decides what gets put in (rebuild, range scan, every queued update);
 *   - the RECONCILER decides what gets to stay.
 *
 * They are asserted TOGETHER here, against one shared predicate, because that pairing is the
 * fix. Two separately-correct-looking filters that disagree is the failure mode.
 */

// The reconciler module reaches for the search client and the db client at import time; neither
// is needed to read its predicate.
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: null,
  metricsSearchClient: null,
  updateDocs: vi.fn(async () => undefined),
}));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

const { USER_SEARCH_INDEX_ELIGIBILITY, userSearchIndexEligibilitySql } = await import(
  '~/server/search-index/user-index-eligibility'
);
const { CLEANUP_INDEXES } = await import('~/server/meilisearch/cleanup');
const { Prisma } = await import('@prisma/client');

/** Collapse whitespace so an assertion is about the PREDICATE, not about indentation. */
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('user search index eligibility', () => {
  /**
   * The whole normalised predicate, pinned. Deliberately not a substring match: a substring
   * assertion is satisfied by a clause that is present but AND-ed with something that makes it
   * unreachable, and it says nothing about a clause being dropped.
   */
  it('is exactly: not the deleted-content sentinel, not soft-deleted, and NOT BANNED', () => {
    expect(norm(Prisma.join(USER_SEARCH_INDEX_ELIGIBILITY, ' AND ').sql)).toBe(
      'u.id != -1 AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL'
    );
  });

  it('exposes the same predicate as one joined fragment', () => {
    expect(norm(userSearchIndexEligibilitySql().sql)).toBe(
      'u.id != -1 AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL'
    );
  });

  describe('the nightly reconciler keeps the same accounts the indexer writes', () => {
    const usersConfig = CLEANUP_INDEXES.find((c) => c.key === 'users');

    it('has a users config at all', () => {
      expect(usersConfig).toBeDefined();
    });

    /**
     * The seam. The reconciler is what actually EVICTS a document for an account that changed
     * state after it was indexed, so its predicate carrying the ban clause is the load-bearing
     * assertion — not the write-side filter, which only stops NEW writes.
     */
    it('reconciles users on the shared eligibility predicate, ban clause included', () => {
      const sql = norm(usersConfig!.where([11, 22]).sql);
      expect(sql).toContain('u."bannedAt" IS NULL');
      expect(sql).toContain('u."deletedAt" IS NULL');
      expect(sql).toContain('u.id != -1');
    });

    /**
     * The OTHER half of the seam. `M1c`: an indexer that keeps its own copy of the predicate,
     * ban clause dropped, is invisible to every assertion above — the shared module is still
     * correct and the reconciler still uses it, so nothing else goes red while every write
     * re-inserts the accounts the reconciler just removed.
     */
    it('the INDEXER writes on the same predicate it is reconciled against', async () => {
      const { USERS_INDEX_WHERE } = await import('~/server/search-index/users.search-index');
      expect(norm(Prisma.join(USERS_INDEX_WHERE, ' AND ').sql)).toBe(
        norm(userSearchIndexEligibilitySql().sql)
      );
      // Pinned literally as well, so the two sides agreeing on the WRONG predicate is not a pass.
      expect(norm(Prisma.join(USERS_INDEX_WHERE, ' AND ').sql)).toBe(
        'u.id != -1 AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL'
      );
    });

    /**
     * The presence half of the ban assertion above. An empty/near-empty predicate would satisfy
     * "does not mention bannedAt" for every OTHER index too, so a mutant that guts the shared
     * module has to be caught by something that still expects real content elsewhere.
     */
    it('leaves the other indexes untouched — this predicate is user-scoped', () => {
      const models = CLEANUP_INDEXES.find((c) => c.key === 'models');
      expect(models).toBeDefined();
      const modelsSql = norm(models!.where([11]).sql);
      expect(modelsSql).toContain('m.status =');
      expect(modelsSql).not.toContain('bannedAt');
    });
  });
});
