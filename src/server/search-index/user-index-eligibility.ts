import { Prisma } from '@prisma/client';

/**
 * The ONE definition of "this account belongs in the user search index".
 *
 * Kept a leaf module — no meilisearch client, no db client — so a test can read it without
 * pulling the search-index runtime in, and so the two places that decide index membership
 * cannot disagree:
 *
 *   1. `users.search-index.ts` — what gets WRITTEN (full rebuild, the createdAt range scan,
 *      and every targeted `Update` drained from the queue).
 *   2. `meilisearch/cleanup.ts` — what gets KEPT by the nightly reconciler; a document whose
 *      id this predicate no longer returns is deleted.
 *
 * 🔴 BOTH HALVES ARE LOAD-BEARING, and the pair is the fix. A write-side filter alone leaves
 * documents that were indexed before the account changed state sitting there forever, because
 * the incremental range scan keys on `createdAt` — an existing row is never re-pulled by it.
 * A reconciler-side filter alone is undone on the next write, because the metrics refresh
 * enqueues an `Update` for every account whose counters moved, which re-inserts it.
 *
 * `bannedAt IS NULL` is here because a banned account must not be discoverable through user
 * search, and because search results are consumed BY ID by pickers that grant access.
 */
export const USER_SEARCH_INDEX_ELIGIBILITY: Prisma.Sql[] = [
  Prisma.sql`u.id != -1`,
  Prisma.sql`u."deletedAt" IS NULL`,
  Prisma.sql`u."bannedAt" IS NULL`,
];

/** The same predicate as a single `AND`-joined fragment, for callers building one WHERE. */
export const userSearchIndexEligibilitySql = () =>
  Prisma.join(USER_SEARCH_INDEX_ELIGIBILITY, ' AND ');
