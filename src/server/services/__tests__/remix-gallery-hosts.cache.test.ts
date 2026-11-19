import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';

/**
 * The negative cache in front of the remix-gallery card summaries (remix-gallery-hosts.cache): the
 * real createCachedObject over a Redis fake that holds what it is given, and the reads through a
 * Kysely fake that answers per statement. Which writers bust it is pinned in
 * remix-gallery-hosts-writers.test.ts (the ledger) and remix-gallery.service.test.ts (behaviour).
 */

const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('~/server/db/kyselyDb.lazy', async () =>
  (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
);

const { getRemixGalleryCardSummaries } = await import('~/server/services/remix-gallery.service');
const { bustRemixGalleryHosts, getRemixGalleryHostsWithEntries, REMIX_GALLERY_HOSTS_TTL } =
  await import('~/server/services/remix-gallery-hosts.cache');

// Pairwise distinct, and distinct from every count, level and limit below.
const EMPTY_HOST = 7101;
const OTHER_EMPTY_HOST = 7102;
const HOST = 7103;
const ENTRY = 7204;
const ENTRY_2 = 7205;
const KEY = 'packed:caches:remix-gallery-hosts';
// One past int4: no image has this id, and Postgres rejects it where it reads an int4.
const PAST_INT4 = 2 ** 31;

const isHostsLookup = (strings: readonly string[]) =>
  strings.join('?').includes('SELECT DISTINCT pl."targetId" AS "hostId"');
const isSummaries = (strings: readonly string[]) => strings.join('?').includes('WITH visible AS');

/** Hosts that have a placement, as the database would say. */
let withPlacement: number[] = [];
/** The summary rows the database would return, as pg parses them (int8 `total` as a number). */
let summaryRows: Record<string, unknown>[] = [];
const lookups: number[][] = [];
const summaryIds: unknown[][] = [];

let store: ReturnType<typeof installFakeCacheRedis>;

beforeEach(() => {
  vi.clearAllMocks();
  store = installFakeCacheRedis();
  withPlacement = [];
  summaryRows = [];
  lookups.length = 0;
  summaryIds.length = 0;
  kysely.read
    .mockReset()
    .mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
      // Both statements bind ids where Postgres reads an int4 (`ANY(?::int[])`, `IN (...)`).
      const { rejectPastInt4 } = await import('~/test-utils/kysely-raw-fake');
      rejectPastInt4(values);
      if (isHostsLookup(strings)) {
        const asked = values[2] as number[];
        lookups.push(asked);
        return asked.filter((id) => withPlacement.includes(id)).map((hostId) => ({ hostId }));
      }
      if (isSummaries(strings)) {
        // The IN list's ids: every bound number that is an asked host.
        summaryIds.push(
          values.filter((v) => [EMPTY_HOST, OTHER_EMPTY_HOST, HOST].includes(v as never))
        );
        return summaryRows;
      }
      throw new Error(`unexpected statement: ${strings.join('?').slice(0, 80)}`);
    });
});

describe('the card summaries behind the hosts-with-entries cache', () => {
  it('asks the database nothing more for hosts with no placement, and caches that', async () => {
    const first = await getRemixGalleryCardSummaries({
      imageIds: [EMPTY_HOST, OTHER_EMPTY_HOST],
      browsingLevel: 1,
    });
    expect(first).toEqual({});
    expect(lookups).toEqual([[EMPTY_HOST, OTHER_EMPTY_HOST]]);
    expect(summaryIds).toEqual([]);

    // Answered from Redis: not even the lookup runs again.
    const second = await getRemixGalleryCardSummaries({
      imageIds: [OTHER_EMPTY_HOST, EMPTY_HOST],
      browsingLevel: 1,
    });
    expect(second).toEqual({});
    expect(lookups).toHaveLength(1);
    expect(kysely.read).toHaveBeenCalledTimes(1);
    expect(store.peek(`${KEY}:${EMPTY_HOST}`)).toMatchObject({
      hostId: EMPTY_HOST,
      notFound: true,
    });
  });

  it('runs the summary read for the hosts with a placement only, with its exact result', async () => {
    withPlacement = [HOST];
    summaryRows = [
      {
        hostId: HOST,
        imageId: ENTRY,
        url: 'entry-a',
        type: 'image',
        nsfwLevel: 1,
        username: 'a',
        total: 3,
      },
      {
        hostId: HOST,
        imageId: ENTRY_2,
        url: 'entry-b',
        type: 'video',
        nsfwLevel: 2,
        username: null,
        total: 3,
      },
    ];

    const result = await getRemixGalleryCardSummaries({
      imageIds: [EMPTY_HOST, HOST],
      browsingLevel: 1,
    });

    expect(summaryIds).toEqual([[HOST]]);
    expect(result).toStrictEqual({
      [HOST]: {
        count: 3,
        entries: [
          { imageId: ENTRY, url: 'entry-a', type: 'image', username: 'a', nsfwLevel: 1 },
          { imageId: ENTRY_2, url: 'entry-b', type: 'video', username: null, nsfwLevel: 2 },
        ],
      },
    });
    expect(store.peek(`${KEY}:${HOST}`)).toMatchObject({ hostId: HOST });
    expect(store.peek(`${KEY}:${HOST}`)).not.toHaveProperty('notFound');
  });

  it('never reaches the Prisma query engine', async () => {
    withPlacement = [HOST];
    await getRemixGalleryCardSummaries({ imageIds: [EMPTY_HOST, HOST], browsingLevel: 1 });
    expect(kysely.read).toHaveBeenCalledTimes(2);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('the lookup', () => {
  it('asks, in one statement, which of the hosts have a remix-gallery placement on an image', async () => {
    await getRemixGalleryHostsWithEntries([EMPTY_HOST, HOST, EMPTY_HOST]);
    expect(kysely.read).toHaveBeenCalledTimes(1);
    const [strings, ...values] = kysely.read.mock.calls[0] as [string[], ...unknown[]];
    const text = strings.join('?').replace(/\s+/g, ' ');
    expect(text).toContain(
      'FROM "Placement" pl WHERE pl.surface = ? AND pl."targetType" = ? AND pl."targetId" = ANY(?::int[])'
    );
    expect(values).toEqual(['remixGallery', 'image', [EMPTY_HOST, HOST]]);
  });
});

describe('ids past int4', () => {
  // Prisma's raw reads answered them with no rows; through the pg pools the same statements are a
  // range error. So they are dropped before any statement: a card with one still answers.
  it('are dropped before the lookup and the summaries, and the rest still answer', async () => {
    withPlacement = [HOST];
    summaryRows = [
      {
        hostId: HOST,
        imageId: ENTRY,
        url: 'entry-a',
        type: 'image',
        nsfwLevel: 1,
        username: 'a',
        total: 1,
      },
    ];

    const result = await getRemixGalleryCardSummaries({
      imageIds: [PAST_INT4, HOST],
      browsingLevel: 1,
    });

    expect(result).toStrictEqual({
      [HOST]: {
        count: 1,
        entries: [{ imageId: ENTRY, url: 'entry-a', type: 'image', username: 'a', nsfwLevel: 1 }],
      },
    });
    expect(lookups).toEqual([[HOST]]);
    expect(summaryIds).toEqual([[HOST]]);
  });

  it('alone, ask the database nothing and have no entries', async () => {
    expect(await getRemixGalleryHostsWithEntries([PAST_INT4, -PAST_INT4 - 1])).toEqual(new Set());
    expect(kysely.read).not.toHaveBeenCalled();
  });
});

describe('busting', () => {
  it('a bust drops a cached "no placement", so a host that gained one is read again', async () => {
    expect(await getRemixGalleryHostsWithEntries([EMPTY_HOST])).toEqual(new Set());
    withPlacement = [EMPTY_HOST];
    // Still the cached answer: nothing told the cache.
    expect(await getRemixGalleryHostsWithEntries([EMPTY_HOST])).toEqual(new Set());

    await bustRemixGalleryHosts([EMPTY_HOST]);

    expect(await getRemixGalleryHostsWithEntries([EMPTY_HOST])).toEqual(new Set([EMPTY_HOST]));
    expect(lookups).toEqual([[EMPTY_HOST], [EMPTY_HOST]]);
  });

  it('busts only the hosts it is given', async () => {
    await getRemixGalleryHostsWithEntries([EMPTY_HOST, OTHER_EMPTY_HOST]);
    withPlacement = [EMPTY_HOST, OTHER_EMPTY_HOST];
    await bustRemixGalleryHosts([EMPTY_HOST]);

    expect(await getRemixGalleryHostsWithEntries([EMPTY_HOST, OTHER_EMPTY_HOST])).toEqual(
      new Set([EMPTY_HOST])
    );
  });

  it('never throws, so a committed write is never reported as failed', async () => {
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    vi.mocked(redisMock.redis.packed.set).mockRejectedValueOnce(new Error('redis down'));
    await expect(bustRemixGalleryHosts([HOST])).resolves.toBeUndefined();
  });
});

it('caches an answer for a day', () => {
  // A literal: the number is the contract.
  expect(REMIX_GALLERY_HOSTS_TTL).toBe(86400);
});
