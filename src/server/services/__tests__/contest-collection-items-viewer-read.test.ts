import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';

// `image.getContestCollectionDetails` serves contest entries cached per image for every viewer, so
// two per-viewer rules are applied after the cache read:
// - an entry in a collection the viewer may not read (collection.getById's rule) is not listed;
// - each entry's judge scores are the viewer's own, except for the collection's managers and
//   moderators, who see all.
// Mock recipe from contest-collection-rejection-visibility.test.ts.
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { getImageContestCollectionDetails } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const COLLECTION_ID = 10;
const COLLECTION_OWNER_ID = 900;
const JUDGE_A = 31;
const JUDGE_B = 32;
const STRANGER_ID = 7;
const SUBMITTER_ID = 8;
const IMAGE_OWNER_ID = 9;
const SCORES = [
  { userId: JUDGE_A, score: 8 },
  { userId: JUDGE_B, score: 3 },
];

// The item cache is a module-level LRU keyed by imageId: every read uses a fresh id.
let nextImageId = 5000;

function mockQueries({
  imageId,
  read,
  write = 'Private',
}: {
  imageId: number;
  read: string;
  write?: string;
}) {
  dbMock.dbRead.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    if (sql.includes('"CollectionItem" ci')) {
      return Promise.resolve([
        {
          id: 77,
          imageId,
          addedById: SUBMITTER_ID,
          status: 'ACCEPTED',
          rejectionReason: null,
          rejectionDetail: null,
          tag: null,
          collection: {
            id: COLLECTION_ID,
            name: 'Test Contest',
            metadata: { forcedBrowsingLevel: 1 },
            mode: 'Contest',
          },
          scores: SCORES,
        },
      ]);
    }
    return Promise.resolve([
      {
        id: COLLECTION_ID,
        read,
        write,
        userId: COLLECTION_OWNER_ID,
        type: 'Image',
        mode: 'Contest',
        collaborationDisabledAt: null,
        contributorPermissions: null,
        hasAcceptedSeat: false,
      },
    ]);
  });
}

async function details(
  viewer: { userId?: number; isModerator?: boolean; imageOwnerId?: number },
  read: 'Public' | 'Unlisted' | 'Private' = 'Public',
  write: 'Private' | 'Public' | 'Review' = 'Private'
) {
  const imageId = nextImageId++;
  mockQueries({ imageId, read, write });
  return getImageContestCollectionDetails({ id: imageId, ...viewer });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('contest entries in a collection the viewer may not read', () => {
  it('lists no entry of a Private collection to a stranger or signed out', async () => {
    expect(await details({ userId: STRANGER_ID }, 'Private')).toEqual([]);
    expect(await details({}, 'Private')).toEqual([]);
  });

  it("lists a Private collection's entry to its owner, a moderator and its submitter", async () => {
    expect(await details({ userId: COLLECTION_OWNER_ID }, 'Private')).toHaveLength(1);
    expect(await details({ userId: SUBMITTER_ID }, 'Private')).toHaveLength(1);
    expect(await details({ userId: STRANGER_ID, isModerator: true }, 'Private')).toHaveLength(1);
  });

  it("lists a Private collection's entry to the image's owner when someone else submitted it", async () => {
    expect(
      await details({ userId: IMAGE_OWNER_ID, imageOwnerId: IMAGE_OWNER_ID }, 'Private')
    ).toHaveLength(1);
    // Control: owning the image is what counts, not being named as an owner of some other image.
    expect(await details({ userId: STRANGER_ID, imageOwnerId: IMAGE_OWNER_ID }, 'Private')).toEqual(
      []
    );
  });

  it.each(['Public', 'Review'] as const)(
    "lists no one else's entry to a viewer who may only submit (write %s) to a Private collection",
    async (write) => {
      expect(await details({ userId: STRANGER_ID }, 'Private', write)).toEqual([]);
    }
  );

  it('lists entries of Public and Unlisted collections to anyone (control)', async () => {
    expect(await details({}, 'Public')).toHaveLength(1);
    expect(await details({ userId: STRANGER_ID }, 'Unlisted')).toHaveLength(1);
  });
});

describe('judge scores on contest entries', () => {
  const scoresFor = async (viewer: { userId?: number; isModerator?: boolean }) =>
    (await details(viewer))[0].scores;

  it('shows a judge only their own score', async () => {
    expect(await scoresFor({ userId: JUDGE_A })).toEqual([{ userId: JUDGE_A, score: 8 }]);
  });

  it('shows a stranger no scores and a signed-out viewer an empty list', async () => {
    expect(await scoresFor({ userId: STRANGER_ID })).toEqual([]);
    expect(await scoresFor({})).toEqual([]);
  });

  it("shows the collection's owner and a moderator every score (control)", async () => {
    expect(await scoresFor({ userId: COLLECTION_OWNER_ID })).toEqual(SCORES);
    expect(await scoresFor({ userId: STRANGER_ID, isModerator: true })).toEqual(SCORES);
  });
});

describe('the per-viewer filter runs after the shared cache read', () => {
  const itemReads = () =>
    dbMock.dbRead.$queryRaw.mock.calls.filter(([strings]) =>
      (Array.isArray(strings) ? strings.join('') : String(strings)).includes('"CollectionItem" ci')
    ).length;

  it.each([
    ['a reader first, then a stranger', COLLECTION_OWNER_ID, STRANGER_ID, 1, 0],
    ['a stranger first, then a reader', STRANGER_ID, COLLECTION_OWNER_ID, 0, 1],
  ] as const)(
    'answers each viewer by their own permission when %s read the same image',
    async (_, first, second, firstCount, secondCount) => {
      const imageId = nextImageId++;
      mockQueries({ imageId, read: 'Private' });
      const a = await getImageContestCollectionDetails({ id: imageId, userId: first });
      const b = await getImageContestCollectionDetails({ id: imageId, userId: second });
      // The second read is a cache hit: the entries were queried once.
      expect(itemReads()).toBe(1);
      expect(a).toHaveLength(firstCount);
      expect(b).toHaveLength(secondCount);
    }
  );
});
