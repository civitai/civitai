import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleSort } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const { getInfiniteCruciblesHandler } = await import('~/server/controllers/crucible.controller');

/**
 * A fake table of `total` crucibles, served through Prisma's cursor semantics — which are
 * INCLUSIVE: `cursor: { id: n }` returns the row with id n as the first result, and `skip: 1`
 * is what excludes it. Getting that wrong is the whole bug this file covers.
 *
 * 🔴 It is capped, deliberately. The regression is an infinite feed, and a fake that happily
 * serves forever turns that into a hung runner rather than a failed assertion — vitest's
 * testTimeout is setTimeout-based and a tight await loop never yields to it.
 */
const PAGE_CAP = 50;

const fakeTable = (total: number) => {
  const rows = Array.from({ length: total }, (_, i) => ({ id: total - i }));
  dbMock.dbRead.crucible.findMany.mockImplementation(
    async ({ take, cursor, skip }: { take: number; cursor?: { id: number }; skip?: number }) => {
      const start = cursor ? rows.findIndex((r) => r.id === cursor.id) + (skip ?? 0) : 0;
      return rows.slice(start, start + take);
    }
  );
  return rows;
};

/** Pages to exhaustion, or gives up at the cap and says how far it got. */
const drain = async (sort = CrucibleSort.Newest) => {
  const seen: number[] = [];
  let cursor: number | undefined;
  let pages = 0;

  while (pages < PAGE_CAP) {
    const result = await getInfiniteCruciblesHandler({
      input: { limit: 2, sort, cursor } as never,
    });
    pages++;
    seen.push(...result.items.map((x: { id: number }) => x.id));
    if (result.nextCursor == null) return { pages, seen, terminated: true };
    cursor = result.nextCursor;
  }
  return { pages, seen, terminated: false };
};

beforeEach(() => vi.clearAllMocks());

describe('crucible feed paging', () => {
  it('terminates instead of serving the same crucible forever', async () => {
    // The reported regression: the last page still returned a cursor, and because Prisma's
    // cursor is inclusive that cursor pointed at a row already shown — so the feed re-served it
    // and asked for more, indefinitely.
    fakeTable(3);

    const { pages, seen, terminated } = await drain();

    expect(pages).toBeLessThan(PAGE_CAP);
    expect(terminated).toBe(true);
    expect(seen).toEqual([3, 2, 1]);
  });

  it('stops on the page that exactly fills the limit, rather than one empty page later', async () => {
    fakeTable(4);

    const { seen, terminated } = await drain();

    expect(terminated).toBe(true);
    expect(seen).toEqual([4, 3, 2, 1]);
  });

  it('returns no cursor at all when there is a single page', async () => {
    fakeTable(2);

    const result = await getInfiniteCruciblesHandler({ input: { limit: 2 } as never });

    expect(result.items.map((x: { id: number }) => x.id)).toEqual([2, 1]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns no cursor on an empty feed', async () => {
    fakeTable(0);

    const result = await getInfiniteCruciblesHandler({ input: { limit: 2 } as never });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('never serves the same crucible twice', async () => {
    fakeTable(7);

    const { seen, terminated } = await drain();

    expect(terminated).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('asks the database for one row beyond the page, and never returns it', async () => {
    // How "is there more?" is answered. Without the extra row the handler has to guess, and the
    // guess it made was "a full page always has more".
    fakeTable(5);

    const result = await getInfiniteCruciblesHandler({ input: { limit: 2 } as never });

    const [{ take }] = dbMock.dbRead.crucible.findMany.mock.calls[0];
    expect(take).toBe(3);
    expect(result.items).toHaveLength(2);
  });

  it.each([
    ['EndingSoon', CrucibleSort.EndingSoon],
    ['PrizePool', CrucibleSort.PrizePool],
    ['MostEntries', CrucibleSort.MostEntries],
  ])('orders by a unique tiebreaker under %s, so a cursor has one position', async (_l, sort) => {
    // Every sort here is on a non-unique column. Without `id` last, two rows sharing an entryFee
    // have no defined order, and a cursor into that ordering can skip or repeat rows.
    fakeTable(3);

    await getInfiniteCruciblesHandler({ input: { limit: 2, sort } as never });

    const [{ orderBy }] = dbMock.dbRead.crucible.findMany.mock.calls[0];
    expect(orderBy[orderBy.length - 1]).toEqual({ id: 'desc' });
  });
});
