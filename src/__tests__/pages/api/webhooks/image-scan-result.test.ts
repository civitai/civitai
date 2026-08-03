import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '~/pages/api/webhooks/image-scan-result';
import { TagSource, ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';

const {
  mockDbWrite,
  mockInsertTagsOnImageNew,
  mockUpsertTagsOnImageNew,
  mockLogToAxiom,
  tagsDb,
} = vi.hoisted(() => {
  const tagsDb = [
    { id: 100, name: 'hate symbols', nsfwLevel: 32 }, // Blocked
    { id: 200, name: 'teen', nsfwLevel: 1 },         // PG
    { id: 300, name: 'potential celebrity', nsfwLevel: 1 }, // PG
    { id: 400, name: 'some-tag', nsfwLevel: 8 },      // X
    { id: 1001, name: 'pg', nsfwLevel: 1 },
    { id: 1002, name: 'pg-13', nsfwLevel: 2 },
    { id: 1003, name: 'r', nsfwLevel: 4 },
    { id: 1004, name: 'x', nsfwLevel: 8 },
    { id: 1005, name: 'xxx', nsfwLevel: 16 },
  ];
  // Auto-stubbing Prisma-client mock.
  //
  // This suite has broken THREE times (identically) when a new side-effect was added to the
  // webhook's success path that calls a db model/method the hand-listed mock didn't stub
  // (e.g. `dbRead.model3D.findMany` #3051). The call threw `x is not a function`, so
  // `handleSuccess` never reached `res.status(200)` and the 4 pipeline tests failed with
  // `expected vi.fn() to be called with [200]`.
  //
  // Instead of enumerating every model/method, this returns a Proxy that LAZILY creates and
  // caches a `vi.fn()` per (model, method) with a benign default (finders → []/null, mutators →
  // {}/{count:0}, raw-queries → []). A brand-new dependency reference therefore returns a
  // callable stub instead of `undefined`, so a newly-added success-path dep can no longer break
  // the suite. Tests still reach in and override specific methods
  // (`mockDbWrite.image.findUnique.mockImplementation(...)`) exactly as before — the cached fn
  // they configure is the same one production code invokes.
  const createDbMock = () => {
    const benignFor = (method: string) => {
      const fn = vi.fn();
      if (
        method === 'findUnique' ||
        method === 'findFirst' ||
        method === 'findUniqueOrThrow' ||
        method === 'findFirstOrThrow'
      )
        fn.mockResolvedValue(null);
      else if (
        method === 'findMany' ||
        method === 'aggregate' ||
        method === 'groupBy' ||
        method === 'findRaw' ||
        method === 'aggregateRaw'
      )
        fn.mockResolvedValue([]);
      else if (method === 'count') fn.mockResolvedValue(0);
      else if (method === 'createMany' || method === 'updateMany' || method === 'deleteMany')
        fn.mockResolvedValue({ count: 0 });
      // create / update / upsert / delete / connectOrCreate / …
      else fn.mockResolvedValue({});
      return fn;
    };

    const makeModelProxy = () => {
      const methods = new Map<string, ReturnType<typeof vi.fn>>();
      return new Proxy(
        {},
        {
          get(_t, method) {
            if (typeof method !== 'string' || method === 'then') return undefined;
            if (!methods.has(method)) methods.set(method, benignFor(method));
            return methods.get(method);
          },
        }
      );
    };

    const models = new Map<string, unknown>();
    const rootFns = new Map<string, ReturnType<typeof vi.fn>>();

    const db: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== 'string' || prop === 'then') return undefined;
          // Prisma client top-level helpers: $queryRaw, $queryRawUnsafe, $executeRaw(Unsafe),
          // $transaction, $connect, …
          if (prop.startsWith('$')) {
            if (!rootFns.has(prop)) {
              const fn = vi.fn();
              if (prop === '$transaction')
                fn.mockImplementation(async (arg: any) =>
                  typeof arg === 'function' ? arg(db) : Promise.all(arg ?? [])
                );
              else fn.mockResolvedValue([]); // $queryRaw* / $executeRaw* → benign empty rowset
              rootFns.set(prop, fn);
            }
            return rootFns.get(prop);
          }
          if (!models.has(prop)) models.set(prop, makeModelProxy());
          return models.get(prop);
        },
      }
    );
    return db;
  };

  return {
    tagsDb,
    mockDbWrite: createDbMock(),
    mockInsertTagsOnImageNew: vi.fn().mockResolvedValue(undefined),
    mockUpsertTagsOnImageNew: vi.fn().mockResolvedValue(undefined),
    mockLogToAxiom: vi.fn().mockImplementation((args) => {
      console.log('AXIOM LOG:', JSON.stringify(args, null, 2));
      return Promise.resolve();
    }),
  };
});

vi.mock('~/server/db/client', () => ({
  dbWrite: mockDbWrite,
  dbRead: mockDbWrite,
}));

vi.mock('~/server/services/tagsOnImageNew.service', () => ({
  insertTagsOnImageNew: mockInsertTagsOnImageNew,
  upsertTagsOnImageNew: mockUpsertTagsOnImageNew,
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
}));

vi.mock('~/env/server', () => ({
  env: new Proxy({}, {
    get(target, prop: string) {
      if (prop === 'WEBHOOK_TOKEN') return 'mock-webhook-token';
      if (prop === 'BLOCKED_IMAGE_HASH_CHECK') return false;
      if (prop === 'LOGGING') return [];
      if (prop === 'EMAIL_PORT') return 587;
      if (prop === 'DATABASE_SSL') return false;
      if (prop.endsWith('URL') || prop.endsWith('_URL') || prop.endsWith('ENDPOINT')) return 'http://localhost:3000';
      if (prop.endsWith('CONCURRENCY')) return 5;
      return 'mock-value';
    },
  }),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getFeatureFlagsLazy: () => ({
      articleImageScanning: false,
    }),
  };
});

// Mock NewOrder queue
vi.mock('~/server/services/games/new-order.service', () => ({
  addImageToQueue: vi.fn().mockResolvedValue(undefined),
}));

// Mock system-cache
vi.mock('~/server/services/system-cache', () => ({
  getTagRules: vi.fn().mockResolvedValue([]),
}));

// Auto-stubbing `~/server/redis/caches` mock.
//
// The success path busts/refreshes several redis caches (`userImageVideoCountCaches.bust`,
// `tagIdsForImagesCache.refresh`, …). This module was previously hand-listed export-by-export,
// which is how `userImageVideoCountCaches` was MISSED (#3191): accessing a not-listed export
// yields `undefined`, the `.bust()` call throws, and `handleSuccess` never reaches
// `res.status(200)`. Here any accessed export resolves to a benign cache-shaped stub whose every
// method is a `vi.fn()` resolving `undefined`, so a newly-referenced cache export can no longer
// break the suite. Specific behaviours the tests rely on (`tagCacheByName.fetch`) are preserved
// as explicit overrides.
vi.mock('~/server/redis/caches', () => {
  const makeCacheStub = (overrides: Record<string, unknown> = {}) => {
    const methods = new Map<string, unknown>(Object.entries(overrides));
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== 'string' || prop === 'then') return undefined;
          if (!methods.has(prop)) methods.set(prop, vi.fn().mockResolvedValue(undefined));
          return methods.get(prop);
        },
      }
    );
  };

  const known: Record<string, unknown> = {
    tagCacheByName: makeCacheStub({
      fetch: vi.fn().mockImplementation(async (names: string[]) => ({
        found: new Map(),
        missing: names,
      })),
    }),
  };

  // Namespace proxy: known exports return their specific stub; any other accessed export
  // lazily gets a benign cache-shaped stub.
  return new Proxy(known, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === '__esModule') return undefined;
      if (!(prop in target)) target[prop] = makeCacheStub();
      return target[prop];
    },
  });
});

vi.mock('~/utils/signal-client', () => ({
  signalClient: {
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('~/libs/tags', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    tagsToIgnore: {
      Clavata: ['hate symbols'],
    },
  };
});

vi.mock('~/server/services/image.service', () => ({
  getImagesModRules: vi.fn().mockResolvedValue([]),
  queueImageSearchIndexUpdate: vi.fn().mockResolvedValue(undefined),
  enqueueImageIngestion: vi.fn().mockResolvedValue(undefined),
  imageScanTypes: [3, 9], // ImageScanType.WD14, ImageScanType.SpineRating
}));

describe('image-scan-result webhook - pipeline tests', () => {
  const imageDbState = new Map<number, any>();

  const getImageState = (id: number) => {
    if (!imageDbState.has(id)) {
      // Set initial scans: Image 2, 5, 6, 7 have SpineRating pre-completed
      const scans = (id === 2 || id === 5 || id === 6 || id === 7) ? { [TagSource.SpineRating]: Date.now() } : {};
      imageDbState.set(id, {
        id,
        createdAt: new Date(),
        scannedAt: null,
        type: 'image',
        userId: 1,
        meta: {},
        metadata: {},
        postId: null,
        nsfwLevelLocked: id === 7,
        nsfwLevel: id === 7 ? 1 : null,
        scanJobs: { scans },
        ingestion: ImageIngestionStatus.Pending,
      });
    }
    return imageDbState.get(id);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    imageDbState.clear();

    mockDbWrite.image.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => {
      return getImageState(where.id);
    });

    mockDbWrite.tag.findMany.mockImplementation(async ({ where }: any) => {
      if (where.name?.in) {
        const names = where.name.in;
        return tagsDb.filter((t) => names.includes(t.name));
      }
      if (where.id?.in) {
        const ids = where.id.in;
        return tagsDb.filter((t) => ids.includes(t.id));
      }
      return [];
    });

    mockDbWrite.$queryRawUnsafe.mockImplementation(async (query: string) => {
      const match = query.match(/WHERE id = (\d+)/) || query.match(/id = (\d+)/) || query.match(/id IN \((\d+)\)/);
      const id = match ? parseInt(match[1], 10) : 1;
      const state = getImageState(id);

      let source: string | undefined;
      if (query.includes('Clavata')) source = 'Clavata';
      else if (query.includes('WD14')) source = 'WD14';
      else if (query.includes('SpineRating')) source = 'SpineRating';

      if (source) {
        state.scanJobs.scans[source] = Date.now();
      }

      return [
        {
          scanJobs: state.scanJobs,
          type: 'image',
        },
      ];
    });

    mockDbWrite.$queryRaw.mockImplementation(async (query: any, ...values: any[]) => {
      const queryString = Array.isArray(query)
        ? query.join('')
        : query?.strings
        ? query.strings.join('')
        : String(query);

      if (queryString.includes('is_new_user')) {
        return [{ isNewUser: false }];
      }

      if (queryString.includes('ImageResourceNew') || queryString.includes('ImageConnection')) {
        return [{ poi: false, minor: false, hasResource: false }];
      }

      if (queryString.includes('TagsOnImageDetails')) {
        const imageId = values[0];
        const insertedTags = [
          ...mockInsertTagsOnImageNew.mock.calls.flatMap((call) => call[0]),
          ...mockUpsertTagsOnImageNew.mock.calls.flatMap((call) => call[0]),
        ];

        return insertedTags
          .filter((t) => t.imageId === imageId && !t.disabled)
          .map((t) => {
            const tagInfo = tagsDb.find(td => td.id === t.tagId);
            return {
              id: t.tagId,
              name: tagInfo?.name ?? 'unknown-tag',
              nsfwLevel: tagInfo?.nsfwLevel ?? 1,
              confidence: t.confidence,
            };
          });
      }

      return [];
    });
  });

  const runWebhook = (body: any) => {
    const req = {
      method: 'POST',
      query: { token: 'mock-webhook-token' },
      headers: { host: 'localhost:3000' },
      body,
    } as unknown as NextApiRequest;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockImplementation((val) => res),
      send: vi.fn().mockImplementation((val) => res),
    } as unknown as NextApiResponse;

    return { promise: handler(req, res), res };
  };

  it('should prevent tag-bleed between Clavata (ignored) and WD14 (not ignored) concurrently', async () => {
    const reqA = runWebhook({
      id: 1,
      status: 0,
      source: TagSource.Clavata,
      tags: [{ tag: 'hate symbols', confidence: 95 }],
    });

    const reqB = runWebhook({
      id: 2,
      status: 0,
      source: TagSource.WD14,
      tags: [{ tag: 'hate symbols', confidence: 95 }],
    });

    await Promise.all([reqA.promise, reqB.promise]);

    expect(reqA.res.status).toHaveBeenCalledWith(200);
    expect(reqB.res.status).toHaveBeenCalledWith(200);

    const dbUpdates = mockDbWrite.image.update.mock.calls;
    const updateForImage2 = dbUpdates.find((call: any) => call[0].where.id === 2);

    expect(updateForImage2).toBeDefined();
    expect(updateForImage2[0].data.nsfwLevel).toBe(32); // Blocked
    expect(updateForImage2[0].data.ingestion).toBe(ImageIngestionStatus.Scanned);

    const insertedTags = [
      ...mockInsertTagsOnImageNew.mock.calls.flatMap((call) => call[0]),
      ...mockUpsertTagsOnImageNew.mock.calls.flatMap((call) => call[0]),
    ];
    const tagForImage1 = insertedTags.find((t) => t.imageId === 1 && t.tagId === 100);
    const tagForImage2 = insertedTags.find((t) => t.imageId === 2 && t.tagId === 100);

    expect(tagForImage1).toBeDefined();
    expect(tagForImage1.disabled).toBe(true); // Clavata ignores hate symbols

    expect(tagForImage2).toBeDefined();
    expect(tagForImage2.disabled).toBe(false); // WD14 does not ignore hate symbols
  });

  it('should set ingestion to NotFound when status is NotFound', async () => {
    const req = runWebhook({
      id: 3,
      status: 1, // NotFound
      source: TagSource.WD14,
      tags: [],
    });

    await req.promise;

    expect(req.res.status).toHaveBeenCalledWith(200);
    expect(mockDbWrite.image.updateMany).toHaveBeenCalledWith({
      where: { id: 3, ingestion: { in: ['Pending', 'Error'] } },
      data: { ingestion: ImageIngestionStatus.NotFound },
    });
  });

  it('should increment retryCount when status is Unscannable', async () => {
    const req = runWebhook({
      id: 4,
      status: 2, // Unscannable
      source: TagSource.WD14,
      tags: [],
    });

    await req.promise;

    expect(req.res.status).toHaveBeenCalledWith(200);
    expect(mockDbWrite.$queryRawUnsafe).toHaveBeenCalled();
    const queryCall = mockDbWrite.$queryRawUnsafe.mock.calls.find((call: any) =>
      call[0].includes('retryCount') && call[0].includes('4')
    );
    expect(queryCall).toBeDefined();
  });

  it('should set needsReview: minor when minor tag is present and image is NSFW', async () => {
    const req = runWebhook({
      id: 5,
      status: 0,
      source: TagSource.WD14,
      tags: [
        { tag: 'teen', confidence: 95 },
        { tag: 'r', confidence: 95 },
      ],
    });

    await req.promise;

    expect(req.res.status).toHaveBeenCalledWith(200);
    const dbUpdates = mockDbWrite.image.update.mock.calls;
    const updateForImage5 = dbUpdates.find((call: any) => call[0].where.id === 5);
    expect(updateForImage5).toBeDefined();
    expect(updateForImage5[0].data.needsReview).toBe('minor');
  });

  it('should set needsReview: poi when POI tag is present', async () => {
    const req = runWebhook({
      id: 6,
      status: 0,
      source: TagSource.WD14,
      tags: [
        { tag: 'potential celebrity', confidence: 95 },
        { tag: 'pg', confidence: 95 },
      ],
    });

    await req.promise;

    expect(req.res.status).toHaveBeenCalledWith(200);
    const dbUpdates = mockDbWrite.image.update.mock.calls;
    const updateForImage6 = dbUpdates.find((call: any) => call[0].where.id === 6);
    expect(updateForImage6).toBeDefined();
    expect(updateForImage6[0].data.needsReview).toBe('poi');
  });

  it('should not update nsfwLevel if nsfwLevelLocked is true', async () => {
    const req = runWebhook({
      id: 7,
      status: 0,
      source: TagSource.WD14,
      tags: [
        { tag: 'some-tag', confidence: 95 },
        { tag: 'x', confidence: 95 },
      ],
    });

    await req.promise;

    expect(req.res.status).toHaveBeenCalledWith(200);
    const dbUpdates = mockDbWrite.image.update.mock.calls;
    const updateForImage7 = dbUpdates.find((call: any) => call[0].where.id === 7);
    expect(updateForImage7).toBeDefined();
    expect(updateForImage7[0].data.nsfwLevel).toBeUndefined(); // locked, so undefined (not updated)
  });
});
