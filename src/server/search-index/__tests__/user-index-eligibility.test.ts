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
 * 🔴 EVERY ASSERTION HERE PINS A WHOLE NORMALISED WHERE CLAUSE WITH `toBe`, and the write-side
 * ones pin the SQL THAT REACHES `$queryRaw` rather than any constant the query is supposed to
 * be built from. Both choices are scar tissue from an adversarial round that walked the
 * previous version of this file twice, with the guard's text still present each time:
 *
 *   - `toContain('u."bannedAt" IS NULL')` is satisfied by any statement that merely MENTIONS
 *     the clause. `AND (<eligibility> OR u."bannedAt" IS NOT NULL)` makes the reconciler keep
 *     every banned document and still contains the substring — suite green.
 *   - Pinning an exported constant says nothing about the queries. The module had a local
 *     alias beside the constant, and the alias was what the queries read; re-binding the alias
 *     to a two-element copy dropped the ban clause from every write-side query — suite green.
 *
 * So: whole strings, and observed at the boundary. A cosmetic rewording of a predicate will
 * fail these — that is the price of a machine-readable claim, and it is worth paying here.
 * (Only the WHERE is pinned, not the whole statement, so adding a SELECT column stays free.)
 *
 * 🔴 AND THEY ARE A LEDGER OVER EVERY QUERY, NOT A SPOT-CHECK ON THE FIRST ONE. Each assertion
 * pins the COUNT of statements issued as well as their predicates, because a third walk of the
 * same class is "add a second, unfiltered `$queryRaw` beside the guarded one": every existing
 * predicate stays correct, the new writer is simply not looked at, and a description promising
 * "the SQL that reaches `$queryRaw`" reads as coverage it does not provide. A new query here is
 * meant to break these — check its WHERE and add it to the expected list.
 */

// The reconciler module reaches for the search client at import time; it is not needed to read
// a predicate, and the index module pulls `updateDocs` from the same place.
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: null,
  metricsSearchClient: null,
  updateDocs: vi.fn(async () => undefined),
}));

const { USER_SEARCH_INDEX_ELIGIBILITY, userSearchIndexEligibilitySql } = await import(
  '~/server/search-index/user-index-eligibility'
);
const { buildUsersIndexWhere, prepareUsersBatches, pullUsersData } = await import(
  '~/server/search-index/users.search-index'
);
const { CLEANUP_INDEXES } = await import('~/server/meilisearch/cleanup');
const { Prisma } = await import('@prisma/client');

/** Collapse whitespace so an assertion is about the PREDICATE, not about indentation. */
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const ELIGIBILITY = 'u.id != -1 AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL';

/**
 * Re-compose a Prisma tagged-template call into readable SQL. Nested `Prisma.Sql` values expose
 * their own text; scalar bind params become `?`, exactly as the driver would render them.
 */
const renderTag = (strings: TemplateStringsArray, values: unknown[]) => {
  let out = '';
  strings.forEach((str, i) => {
    out += str;
    if (i < values.length) {
      const v = values[i] as { sql?: string };
      out += v && typeof v === 'object' && 'sql' in v ? v.sql : '?';
    }
  });
  return out;
};

/** Every WHERE clause in a statement, normalised — the part an eligibility bug lives in. */
const whereClausesOf = (statement: string) =>
  [...norm(statement).matchAll(/\bWHERE\b\s+(.*?)(?=\s+ORDER BY\b|\s*\)\s*as\b|$)/g)].map(
    (m) => m[1]
  );

/** Drives the real query builders and hands back EVERY statement they issued, in order. */
async function captureQueries(
  run: (ctx: { db: unknown; logger: () => void }) => Promise<unknown>
): Promise<string[]> {
  const captured: string[] = [];
  const db = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push(renderTag(strings, values));
      // `prepareBatches` destructures `data[0]`; a bare `[]` would throw before we could read
      // what it asked for.
      return Promise.resolve([{ startId: 1, endId: 2 }]);
    },
  };
  await run({ db, logger: () => undefined });
  return captured;
}

describe('user search index eligibility', () => {
  it('is exactly: not the deleted-content sentinel, not soft-deleted, and NOT BANNED', () => {
    expect(norm(Prisma.join(USER_SEARCH_INDEX_ELIGIBILITY, ' AND ').sql)).toBe(ELIGIBILITY);
  });

  it('exposes the same predicate as one joined fragment', () => {
    expect(norm(userSearchIndexEligibilitySql().sql)).toBe(ELIGIBILITY);
  });

  /**
   * The write side, observed at the query boundary. These are the assertions that survive a
   * re-bind: they do not care what the module calls anything, only what it asks the database.
   */
  describe('the queries the indexer actually issues', () => {
    it('a TARGETED update — the shape the metrics refresh enqueues — filters banned accounts', async () => {
      const statements = await captureQueries((ctx) =>
        pullUsersData(ctx as never, { type: 'update', ids: [11, 22] }, 0)
      );
      expect(statements).toHaveLength(1);
      expect(statements.flatMap(whereClausesOf)).toEqual([`${ELIGIBILITY} AND u.id IN (?,?)`]);
    });

    it('a full RANGE scan filters banned accounts', async () => {
      const statements = await captureQueries((ctx) =>
        pullUsersData(ctx as never, { type: 'new', startId: 5, endId: 9 }, 0)
      );
      expect(statements).toHaveLength(1);
      expect(statements.flatMap(whereClausesOf)).toEqual([
        `${ELIGIBILITY} AND u.id >= ? AND u.id <= ?`,
      ]);
    });

    it('BOTH bounds queries that size an incremental batch filter banned accounts', async () => {
      const statements = await captureQueries((ctx) =>
        prepareUsersBatches(ctx as never, new Date('2026-01-01T00:00:00.000Z'))
      );
      expect(statements).toHaveLength(1);
      // Two sub-selects, and a fix applied to only one of them is the obvious half-fix.
      expect(statements.flatMap(whereClausesOf)).toEqual([
        `${ELIGIBILITY} AND u."createdAt" >= ?`,
        `${ELIGIBILITY} AND u."createdAt" >= ?`,
      ]);
    });

    it('…and so does a full rebuild, which passes no narrowing clause at all', async () => {
      const statements = await captureQueries((ctx) => prepareUsersBatches(ctx as never));
      expect(statements).toHaveLength(1);
      expect(statements.flatMap(whereClausesOf)).toEqual([ELIGIBILITY, ELIGIBILITY]);
    });

    /**
     * Narrowing clauses come AFTER eligibility and never replace it. Pinned separately from the
     * queries above so the ORDER is a stated contract rather than an accident of two call sites.
     */
    it('appends narrowing clauses to the eligibility predicate rather than replacing it', () => {
      const built = buildUsersIndexWhere(Prisma.sql`u.id = 5`, undefined, Prisma.sql`u.id < 9`);
      expect(norm(Prisma.join(built, ' AND ').sql)).toBe(
        `${ELIGIBILITY} AND u.id = 5 AND u.id < 9`
      );
    });
  });

  describe('the nightly reconciler keeps the same accounts the indexer writes', () => {
    const usersConfig = CLEANUP_INDEXES.find((c) => c.key === 'users');

    it('has a users config at all', () => {
      expect(usersConfig).toBeDefined();
    });

    /**
     * The seam, and the half that actually EVICTS an account which changed state after it was
     * indexed — the incremental sync keys its range scan on `createdAt`, so it never revisits an
     * existing row. Pinned whole: a widened predicate that keeps banned documents is the
     * mutation this exists to catch, and it leaves every substring intact.
     */
    it('reconciles users on exactly the shared eligibility predicate', () => {
      expect(norm(usersConfig!.where([11, 22]).sql)).toBe(`u.id IN (?,?) AND ${ELIGIBILITY}`);
    });

    /**
     * The presence half. An empty or gutted predicate would satisfy "does not mention bannedAt"
     * for every other index too, so something still has to expect real content elsewhere.
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
