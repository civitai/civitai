import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as FliptClient from '~/server/flipt/client';

// `getImageContestCollectionDetails` behind `contest-collection-items-redis-cache`: the shared Redis
// cache must answer every viewer exactly as the per-pod LRU does, must never hold the rejection
// reason (it is per-viewer), must cache an image with no entries, and must drop an entry when its
// status is written through the real write path.
//
// Mock recipe follows contest-collection-rejection-visibility.test.ts (env + infra clients) plus
// the fake cache Redis, so the Redis path runs the real createCachedObject against a store that
// actually holds what it wrote.

const { isFliptMock, createNotificationMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (_flag: string) => false),
  createNotificationMock: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: isFliptMock,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: createNotificationMock,
}));

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

import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { CollectionItemRejectionReason, CollectionItemStatus } from '~/shared/utils/prisma/enums';

const { getImageContestCollectionDetails } = await import('~/server/services/image.service');
const { updateCollectionItemsStatus } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const COLLECTION_OWNER_ID = 900;
const SUBMITTER_ID = 42;
const OTHER_SUBMITTER_ID = 43;
const STRANGER_ID = 7;
const MODERATOR_ID = 8;
const SYSTEM_REVIEWER_ID = 5;
const DETAIL = 'Crop out the watermark.';

type Row = {
  id: number;
  imageId: number;
  addedById: number | null;
  status: string;
  rejectionReason: string | null;
  rejectionDetail: string | null;
  tag: { id: number; name: string } | null;
  collection: { id: number; name: string; metadata: unknown; mode: 'Contest' };
  scores: { userId: number; score: number }[];
};

// What the database holds. Each test sets it; the SQL mock below reads it on every call, so a
// "write" is a change to this array, and a read that does not reflect it came from a cache.
let rows: Row[] = [];
let itemLookups = 0;
let rejectionLookups: number[][] = [];

// Fields pairwise distinct across the two entries, so a swapped or dropped field shows.
function entriesFor(imageId: number): Row[] {
  return [
    {
      id: 77,
      imageId,
      addedById: SUBMITTER_ID,
      status: 'REJECTED',
      rejectionReason: CollectionItemRejectionReason.Other,
      rejectionDetail: DETAIL,
      tag: null,
      collection: { id: COLLECTION_ID, name: 'Test Contest', metadata: { a: 1 }, mode: 'Contest' },
      scores: [],
    },
    {
      id: 78,
      imageId,
      addedById: OTHER_SUBMITTER_ID,
      status: 'ACCEPTED',
      rejectionReason: null,
      rejectionDetail: null,
      tag: { id: 5, name: 'landscape' },
      collection: { id: COLLECTION_ID, name: 'Test Contest', metadata: { a: 1 }, mode: 'Contest' },
      scores: [{ userId: 3, score: 8 }],
    },
  ];
}

function sqlOf(strings: unknown) {
  return Array.isArray(strings) ? strings.join('') : String(strings);
}

function installDb() {
  dbMock.dbRead.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values) => {
    const sql = sqlOf(strings);
    if (sql.includes('"CollectionItem" ci')) {
      itemLookups++;
      return Promise.resolve(structuredClone(rows));
    }
    if (sql.includes('"rejectionDetail"') && sql.includes('WHERE id IN')) {
      const ids = ((values[0] as { values?: number[] })?.values ?? []).map(Number);
      rejectionLookups.push(ids);
      return Promise.resolve(
        rows
          .filter((r) => ids.includes(r.id))
          .map(({ id, rejectionReason, rejectionDetail }) => ({
            id,
            rejectionReason,
            rejectionDetail,
          }))
      );
    }
    // getUserCollectionPermissionsByIds
    return Promise.resolve([
      {
        id: COLLECTION_ID,
        read: 'Public',
        write: 'Review',
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

function flag(on: boolean) {
  isFliptMock.mockImplementation(async (name: string) =>
    name === FLIPT_FEATURE_FLAGS.CONTEST_COLLECTION_ITEMS_REDIS_CACHE ? on : false
  );
}

// The LRU is module-level and keyed by imageId, so every case takes its own image.
let nextImageId = 5000;

let store: ReturnType<typeof installFakeCacheRedis>;

beforeEach(() => {
  vi.clearAllMocks();
  store = installFakeCacheRedis();
  installDb();
  itemLookups = 0;
  rejectionLookups = [];
  flag(false);
});

const VIEWERS: [string, { userId?: number; isModerator?: boolean }][] = [
  ['a logged-out caller', {}],
  ['a logged-in stranger', { userId: STRANGER_ID }],
  ['the submitter of the rejected entry', { userId: SUBMITTER_ID }],
  ['the submitter of the accepted entry', { userId: OTHER_SUBMITTER_ID }],
  ['the collection manager', { userId: COLLECTION_OWNER_ID }],
  ['a site moderator', { userId: MODERATOR_ID, isModerator: true }],
];

describe('contest collection items: shared cache parity', () => {
  it.each(VIEWERS)('answers %s exactly as the per-pod LRU does', async (_name, viewer) => {
    const id = nextImageId++;
    rows = entriesFor(id);

    flag(false);
    const lru = await getImageContestCollectionDetails({ id, ...viewer });
    flag(true);
    const shared = await getImageContestCollectionDetails({ id, ...viewer });

    // Positive control: the case has entries for both paths to agree on.
    expect(lru).toHaveLength(2);
    expect(shared).toEqual(lru);
  });

  it('shows the reason to the submitter through the shared cache (the gate still opens)', async () => {
    const id = nextImageId++;
    rows = entriesFor(id);
    flag(true);

    const [rejected] = await getImageContestCollectionDetails({ id, userId: SUBMITTER_ID });

    expect(rejected.rejectionReason).toBe(CollectionItemRejectionReason.Other);
    expect(rejected.rejectionDetail).toBe(DETAIL);
  });

  it('never puts the rejection reason in the shared value, and reads it live only for the gate', async () => {
    const id = nextImageId++;
    rows = entriesFor(id);
    flag(true);

    // A stranger passes the gate on nothing, so nothing is read.
    await getImageContestCollectionDetails({ id, userId: STRANGER_ID });
    expect(rejectionLookups).toEqual([]);

    // The submitter of entry 77 passes it on 77 only.
    await getImageContestCollectionDetails({ id, userId: SUBMITTER_ID });
    expect(rejectionLookups).toEqual([[77]]);

    // Positive control: the entry is in the store, so the scan below reads something.
    const values = [...store.keys()].map((key) => JSON.stringify(store.peek(key)));
    expect(values.some((v) => v.includes('landscape'))).toBe(true);
    for (const value of values) {
      expect(value).not.toContain(DETAIL);
      expect(value).not.toContain('rejectionReason');
    }
  });

  it('serves a repeat read from the cache, across viewers', async () => {
    const id = nextImageId++;
    rows = entriesFor(id);
    flag(true);

    await getImageContestCollectionDetails({ id });
    await getImageContestCollectionDetails({ id, userId: STRANGER_ID });

    expect(itemLookups).toBe(1);
  });

  it('caches an image that is in no contest', async () => {
    const id = nextImageId++;
    rows = [];
    flag(true);

    expect(await getImageContestCollectionDetails({ id })).toEqual([]);
    expect(await getImageContestCollectionDetails({ id })).toEqual([]);

    expect(itemLookups).toBe(1);
  });
});

// Rejects entry 78 of `imageId` through the real write path, as the AI review job does.
async function rejectThroughWritePath(imageId: number) {
  dbMock.dbWrite.collection.findUnique.mockResolvedValue({
    id: COLLECTION_ID,
    type: 'Image',
    mode: 'Contest',
    name: 'Test Contest',
    metadata: {},
  });
  // Both the prior-state read and the bust's id lookup; no submitter, so no notification.
  dbMock.dbWrite.collectionItem.findMany.mockResolvedValue([
    {
      id: 78,
      addedById: null,
      status: 'ACCEPTED',
      rejectionReason: null,
      rejectionDetail: null,
      imageId,
      articleId: null,
      modelId: null,
      postId: null,
    },
  ]);

  await updateCollectionItemsStatus({
    input: {
      collectionId: COLLECTION_ID,
      collectionItemIds: [78],
      status: CollectionItemStatus.REJECTED,
      rejectionReason: CollectionItemRejectionReason.Duplicate,
    },
    userId: SYSTEM_REVIEWER_ID,
    isSystem: true,
  });
}

describe('contest collection items: bust on a status write', () => {
  it('reflects a status change made through updateCollectionItemsStatus on the next read', async () => {
    const id = nextImageId++;
    rows = [{ ...entriesFor(id)[1], addedById: null }];
    flag(true);

    const [before] = await getImageContestCollectionDetails({ id });
    expect(before.status).toBe('ACCEPTED');

    // The database moves; the cache has not been told. Control: the cache really is serving, so
    // a read now is stale — without that, the assertion after the write could pass with no bust.
    rows[0].status = 'REJECTED';
    const [stale] = await getImageContestCollectionDetails({ id });
    expect(stale.status).toBe('ACCEPTED');

    await rejectThroughWritePath(id);

    const [after] = await getImageContestCollectionDetails({ id });
    expect(after.status).toBe('REJECTED');
  });

  it('does not let a fill whose lookup read before the bust overwrite it', async () => {
    const id = nextImageId++;
    rows = [{ ...entriesFor(id)[1], addedById: null }];
    flag(true);

    // Hold the first lookup after it has read: it saw ACCEPTED (the replica before the write) and
    // has not written its fill yet.
    const snapshot = structuredClone(rows);
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const passThrough = dbMock.dbRead.$queryRaw.getMockImplementation()!;
    dbMock.dbRead.$queryRaw.mockImplementationOnce(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!sqlOf(strings).includes('"CollectionItem" ci')) return passThrough(strings, ...values);
        started = true;
        await gate;
        return snapshot;
      }
    );

    const slowRead = getImageContestCollectionDetails({ id });
    await vi.waitFor(() => expect(started).toBe(true));

    rows[0].status = 'REJECTED';
    await rejectThroughWritePath(id);

    release();
    const [slow] = await slowRead;
    // Control: the held fill really carried the pre-write value.
    expect(slow.status).toBe('ACCEPTED');

    const [after] = await getImageContestCollectionDetails({ id });
    expect(after.status).toBe('REJECTED');
  });
});
