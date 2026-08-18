import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';

// `getContestCollectionDetails` is a publicProcedure, so the rejection reason — and above all the
// reviewer's free text about someone else's entry — has to be stripped in the SERVICE. The UI gate
// on `isOwnerOrMod || isCollectionJudge` never sees the transport. `status` stays public: it was
// public before the feature and these tests pin that it still is.
//
// Mock recipe follows image-hide-challenges-exclusion.test.ts: stub env + infra clients + the
// event-engine-common submodule so importing image.service boots no real infra.

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
import { CollectionItemRejectionReason } from '~/shared/utils/prisma/enums';

const COLLECTION_ID = 10;
const COLLECTION_OWNER_ID = 900;
const SUBMITTER_ID = 42;
const STRANGER_ID = 7;
const DETAIL = 'Crop out the watermark.';

// The item cache is a module-level LRU keyed by imageId, so every case needs its own id or it
// reads the previous case's row and asserts against the wrong permissions.
let nextImageId = 1000;

// Both the item fetch and getUserCollectionPermissionsByIds go through dbRead.$queryRaw, so the
// mock routes on the SQL text rather than on call order.
function mockQueries({ imageId, addedById }: { imageId: number; addedById: number | null }) {
  dbMock.dbRead.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);

    if (sql.includes('"CollectionItem" ci')) {
      return Promise.resolve([
        {
          id: 77,
          imageId,
          addedById,
          status: 'REJECTED',
          rejectionReason: CollectionItemRejectionReason.Other,
          rejectionDetail: DETAIL,
          tag: null,
          collection: { id: COLLECTION_ID, name: 'Test Contest', metadata: {}, mode: 'Contest' },
          scores: [],
        },
      ]);
    }

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

async function read({
  userId,
  addedById = SUBMITTER_ID,
}: {
  userId?: number;
  addedById?: number | null;
}) {
  const imageId = nextImageId++;
  mockQueries({ imageId, addedById });
  const [item] = await getImageContestCollectionDetails({ id: imageId, userId });
  return item;
}

describe('getImageContestCollectionDetails rejection visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the reason and the free text from a logged-out caller', async () => {
    const item = await read({ userId: undefined });

    expect(item.rejectionReason).toBeNull();
    expect(item.rejectionDetail).toBeNull();
  });

  it('hides them from a logged-in stranger', async () => {
    const item = await read({ userId: STRANGER_ID });

    expect(item.rejectionReason).toBeNull();
    expect(item.rejectionDetail).toBeNull();
  });

  // `undefined === null` is already false, but an anonymous read of an item with no recorded
  // submitter must never resolve to "the caller is the submitter" by some later refactor.
  it('hides them from a logged-out caller on an item with no submitter', async () => {
    const item = await read({ userId: undefined, addedById: null });

    expect(item.rejectionReason).toBeNull();
    expect(item.rejectionDetail).toBeNull();
  });

  it('shows them to the submitter', async () => {
    const item = await read({ userId: SUBMITTER_ID });

    expect(item.rejectionReason).toBe(CollectionItemRejectionReason.Other);
    expect(item.rejectionDetail).toBe(DETAIL);
  });

  it('shows them to whoever manages the collection', async () => {
    const item = await read({ userId: COLLECTION_OWNER_ID });

    expect(item.permissions?.manage).toBe(true);
    expect(item.rejectionReason).toBe(CollectionItemRejectionReason.Other);
    expect(item.rejectionDetail).toBe(DETAIL);
  });

  it('still reports the status publicly', async () => {
    const item = await read({ userId: undefined });

    expect(item.status).toBe('REJECTED');
  });
});
