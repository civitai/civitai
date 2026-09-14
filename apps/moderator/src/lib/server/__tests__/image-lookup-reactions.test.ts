import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two properties the reaction list's ticket turned on, both of which fail silently.
 *
 * A cap presented as a total is the one number a moderation surface must not get wrong: the header
 * read "Reactions (100+)" on an image with 312, and a truncated list reading as the full picture is
 * how a reaction ring looked like background noise.
 *
 * And the ORDER decides whether "load all" is exhaustive. `createdAt` alone is not unique — a ring
 * lands dozens of reactions inside one second — so without the `id` tiebreak two pages can repeat
 * some rows and drop others, which on a page whose purpose is "see the true set" is the failure mode
 * that matters.
 */

const pgQueries = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(pgQueries);
  return { dbRead: db, dbWrite: db };
});

const { getReactions } = await import('../image-reactions.service');

beforeEach(() => {
  pgQueries.length = 0;
});

describe('getReactions', () => {
  it('counts the total separately instead of inferring it from the page', async () => {
    const result = await getReactions(141988541);

    // Two statements: the page, and a COUNT. One would mean the total is the row count in hand — the
    // exact defect the ticket was opened for.
    expect(pgQueries).toHaveLength(2);
    expect(pgQueries.some((q) => /count\(\*\)/i.test(q))).toBe(true);
    // The driver answers with no rows, so an inferred total would be 0 either way; what is asserted is
    // that a count was ISSUED.
    expect(result.total).toBe(0);
  });

  it('resumes from the last row, never from a row offset', async () => {
    await getReactions(141988541, {
      limit: 100,
      cursor: { createdAt: new Date('2026-09-08T00:00:00Z'), id: 5 },
    });

    const page = pgQueries.find((q) => /order by/i.test(q)) ?? '';
    // 🔴 The revert this catches, and it is a CORRECTNESS revert rather than a performance one.
    // Un-reacting deletes the row outright and the sort is `createdAt DESC`, so every arrival or
    // withdrawal lands at the head and shifts an offset beneath it: three rows withdrawn while a
    // moderator reads means the next page starts three rows late and those three are never fetched —
    // on a page whose whole purpose is "the true set". Three arriving instead re-serves rows already
    // held, and a duplicate key throws out of `{#each}` in production.
    expect(page).not.toMatch(/offset/i);
    expect(page).toMatch(/\("?ir"?\."?createdAt"?, *"?ir"?\."?id"?\) *</i);
    // The tiebreak is what makes the cursor sound: a burst lands dozens of rows inside one second, so
    // a cursor on time alone would re-serve or skip every row sharing the boundary.
    expect(page).toMatch(/order by[\s\S]*"created_?At"[\s\S]*desc[\s\S]*"?id"?[\s\S]*desc/i);
  });

  it('reports no next cursor once a page comes back short', async () => {
    // The driver answers with no rows, so this page is shorter than its limit — the end of the set.
    // Handing back a cursor there costs the caller a round trip to learn it is done.
    const result = await getReactions(141988541, { limit: 100 });

    expect(result.nextCursor).toBeNull();
  });

  it('does not cap the count query along with the page', async () => {
    await getReactions(141988541, { limit: 10 });

    // A `limit` on the COUNT would make the total max out at the page size — a subtler spelling of
    // reporting the cap as the answer.
    const count = pgQueries.find((q) => /count\(\*\)/i.test(q)) ?? '';
    expect(count).not.toMatch(/limit/i);
  });
});
