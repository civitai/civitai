import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Paging through the public comics feed (the site's comics page scrolls through it) shows every
 * comic exactly once: no gap and no repeat at a page boundary, for each sort.
 */

const IDS = [990000106, 990000105, 990000104, 990000103, 990000102, 990000101];

const row = (id: number) => ({
  id,
  name: `Comic ${id}`,
  description: null,
  coverImage: null,
  heroImage: null,
  heroImagePosition: null,
  genre: null,
  nsfwLevel: 1,
  updatedAt: new Date(2026, 0, 1, 0, 0, id - 990000000),
  user: { id: 990000001, username: 'creator', image: null, deletedAt: null, cosmetics: [] },
  chapters: [],
});

/** Prisma's `findMany` over the fixture, newest first: `cursor` is inclusive and `skip` drops from it. */
function findMany(args: {
  where?: { id?: { in: number[] } };
  take?: number;
  cursor?: { id: number };
  skip?: number;
}) {
  let rows = IDS.map(row);
  if (args.where?.id?.in) rows = rows.filter((r) => args.where!.id!.in.includes(r.id));
  if (args.cursor) {
    const at = rows.findIndex((r) => r.id === args.cursor!.id);
    rows = rows.slice(at + (args.skip ?? 0));
  }
  return Promise.resolve(args.take != null ? rows.slice(0, args.take) : rows);
}

// Ranked sorts read (rank, id) from raw SQL, highest first; a cursor keeps the rows strictly after it.
const FOLLOWERS: Record<number, number> = {
  990000106: 1,
  990000105: 3,
  990000104: 3,
  990000103: 2,
  990000102: 5,
  990000101: 3,
};
const RANKED = Object.entries(FOLLOWERS)
  .map(([id, rank]) => ({ id: Number(id), rank_value: BigInt(rank) }))
  .sort((a, b) => Number(b.rank_value - a.rank_value) || b.id - a.id);

function rankedRows(query: { values: unknown[] } | TemplateStringsArray) {
  // Other reads on the path (the viewer's hidden users) are tagged templates and find nothing.
  if (Array.isArray(query)) return Promise.resolve([]);
  const { values } = query as { values: unknown[] };
  const rank = values.find((v): v is bigint => typeof v === 'bigint');
  if (rank == null) return Promise.resolve(RANKED);
  const id = values[values.indexOf(rank) + 1] as number;
  return Promise.resolve(
    RANKED.filter((r) => r.rank_value < rank || (r.rank_value === rank && r.id < id))
  );
}

const caller = comicsRouter.createCaller({
  user: undefined,
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  features: { trpcFlagGuardPerRequest: true, comicCreator: true, isGreen: false },
  req: undefined,
  res: { setHeader: () => undefined },
  cache: { edgeTTL: 0 },
  track: {},
  ip: '127.0.0.1',
} as never);

async function pageThrough(sort: 'Newest' | 'MostFollowed', limit: number) {
  const seen: number[] = [];
  let cursor: number | string | undefined;
  for (let page = 0; page < IDS.length; page++) {
    const { items, nextCursor } = await caller.getPublicProjects({ limit, sort, cursor });
    seen.push(...items.map((item) => item.id));
    if (nextCursor == null) break;
    cursor = nextCursor;
  }
  return seen;
}

beforeEach(() => {
  dbMock.dbRead.comicProject.findMany.mockReset().mockImplementation(findMany as never);
  dbMock.dbRead.$queryRaw.mockReset().mockImplementation(rankedRows as never);
});

describe('comics.getPublicProjects paging', () => {
  it.each([1, 2, 3, 4, 5])('Newest, %i per page, shows all six comics once', async (limit) => {
    expect(await pageThrough('Newest', limit)).toEqual(IDS);
  });

  it.each([1, 2, 4])('MostFollowed, %i per page, shows all six comics once', async (limit) => {
    expect(await pageThrough('MostFollowed', limit)).toEqual(RANKED.map((r) => r.id));
  });
});
