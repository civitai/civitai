import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processImageScanWorkflow } from '~/server/services/image-scan-result.service';
import { processImageScanningWorkflow } from '~/server/services/image-scanning-result.service';
import { clickhouse } from '~/server/clickhouse/client';
import { signalClient } from '~/utils/signal-client';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { TagSource, ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type * as BlocklistService from '~/server/services/blocklist.service';

const {
  mockDbWrite,
  mockInsertTagsOnImageNew,
  mockUpsertTagsOnImageNew,
  mockLogToAxiom,
  mockClickhouseQuery,
  envOverrides,
  tagsDb,
} = vi.hoisted(() => {
  const tagsDb = [
    { id: 100, name: 'hate symbols', nsfwLevel: 32 }, // Blocked
    { id: 200, name: 'teen', nsfwLevel: 1 }, // PG
    { id: 300, name: 'potential celebrity', nsfwLevel: 1 }, // PG
    { id: 400, name: 'some-tag', nsfwLevel: 8 }, // X
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
    envOverrides: { BLOCKED_IMAGE_HASH_CHECK: false } as { BLOCKED_IMAGE_HASH_CHECK: boolean },
    mockClickhouseQuery: vi.fn().mockResolvedValue([{ count: 0 }]),
    mockDbWrite: createDbMock(),
    mockInsertTagsOnImageNew: vi.fn().mockResolvedValue(undefined),
    mockUpsertTagsOnImageNew: vi.fn().mockResolvedValue(undefined),
    mockLogToAxiom: vi.fn().mockImplementation((args) => {
      console.log('AXIOM LOG:', JSON.stringify(args, null, 2));
      return Promise.resolve();
    }),
  };
});

// Partial mock: the real `stripBenignPhrases` reads Redis/Postgres, which no other
// test in this file needs. Default is passthrough so every existing case is
// unaffected; the benign-phrase cases below drive it directly.
const mockStripBenignPhrases = vi.fn(async (text?: string) => text ?? '');
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  stripBenignPhrases: (text?: string, type?: unknown) => mockStripBenignPhrases(text, type),
}));

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
  env: new Proxy(
    {},
    {
      get(target, prop: string) {
        if (prop === 'WEBHOOK_TOKEN') return 'mock-webhook-token';
        if (prop === 'BLOCKED_IMAGE_HASH_CHECK') return envOverrides.BLOCKED_IMAGE_HASH_CHECK;
        if (prop === 'LOGGING') return [];
        if (prop === 'EMAIL_PORT') return 587;
        if (prop === 'DATABASE_SSL') return false;
        if (prop.endsWith('URL') || prop.endsWith('_URL') || prop.endsWith('ENDPOINT'))
          return 'http://localhost:3000';
        if (prop.endsWith('CONCURRENCY')) return 5;
        return 'mock-value';
      },
    }
  ),
}));

// Spread the real module so the Tracker and the re-exported base client stay intact — two modules
// in the handler's graph import from this path. Only `clickhouse` is replaced, and doing so makes
// it truthy for the whole file, where the real shim resolves it to undefined under this suite's
// env proxy: every `if (!clickhouse) return` guard now falls through to the stub below.
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {
    $query: mockClickhouseQuery,
    // Stubbed because the guards above now fall through: the real client also exposes these, and
    // a path reaching one would otherwise fail as `clickhouse.insert is not a function`.
    $exec: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ json: async () => [] }),
  },
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
}));

// Render a Prisma tagged-template call the way the driver does: nested `Prisma.sql` fragments
// are inlined, every interpolated value becomes a `$n` placeholder. A value that shows up in
// `text` rather than `params` is being concatenated into SQL, which is what the injection tests
// below assert against.
const renderSql = (strings: readonly string[], values: any[]): { text: string; params: any[] } => {
  let text = '';
  const params: any[] = [];
  strings.forEach((part, i) => {
    text += part;
    if (i >= values.length) return;
    const value = values[i];
    if (value && Array.isArray(value.strings) && Array.isArray(value.values)) {
      const inner = renderSql(value.strings, value.values);
      text += inner.text.replace(/\$(\d+)/g, (_m, n) => `$${params.length + Number(n)}`);
      params.push(...inner.params);
    } else {
      params.push(value);
      text += `$${params.length}`;
    }
  });
  return { text, params };
};

describe('image-scan-result webhook - pipeline tests', () => {
  const imageDbState = new Map<number, any>();
  const imageUpdates: { text: string; params: any[] }[] = [];

  const getImageState = (id: number) => {
    if (!imageDbState.has(id)) {
      // Set initial scans: Image 2, 5, 6, 7 have SpineRating pre-completed
      const scans =
        id === 2 || id === 5 || id === 6 || id === 7 ? { [TagSource.SpineRating]: Date.now() } : {};
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
    imageUpdates.length = 0;
    envOverrides.BLOCKED_IMAGE_HASH_CHECK = false;
    mockClickhouseQuery.mockResolvedValue([{ count: 0 }]);

    mockDbWrite.image.findUnique.mockImplementation(
      async ({ where }: { where: { id: number } }) => {
        return getImageState(where.id);
      }
    );

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

    mockDbWrite.$queryRaw.mockImplementation(async (query: any, ...values: any[]) => {
      const queryString = Array.isArray(query)
        ? query.join('')
        : query?.strings
        ? query.strings.join('')
        : String(query);

      if (queryString.includes('UPDATE "Image"')) {
        const rendered = renderSql(Array.isArray(query) ? query : query.strings, values);
        imageUpdates.push(rendered);

        const idIndex = rendered.text.match(/id = \$(\d+)/);
        const id = idIndex ? rendered.params[Number(idIndex[1]) - 1] : 1;
        const state = getImageState(id);

        const sourceIndex = rendered.text.match(/jsonb_build_object\(\$(\d+)::text/);
        const source = sourceIndex ? rendered.params[Number(sourceIndex[1]) - 1] : undefined;
        if (source) state.scanJobs.scans[source] = Date.now();

        return [{ scanJobs: state.scanJobs, type: 'image' }];
      }

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
            const tagInfo = tagsDb.find((td) => td.id === t.tagId);
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

  it('creates a never-before-seen tag with the columns the Tag table requires', async () => {
    const passthrough = mockDbWrite.$queryRaw.getMockImplementation();
    let tagInsert: { text: string; params: any[] } | undefined;

    mockDbWrite.$queryRaw.mockImplementation(async (query: any, ...values: any[]) => {
      const strings = Array.isArray(query) ? query : query.strings;
      if (!strings.join('').includes('INSERT INTO "Tag"')) return passthrough(query, ...values);

      tagInsert = renderSql(strings, values);
      // Model the real 23502: both columns are NOT NULL with no DB default.
      for (const column of ['"updatedAt"', 'target']) {
        if (!tagInsert.text.includes(column))
          throw new Error(`Raw query failed. Code: \`23502\`. "Tag" insert omits ${column}`);
      }
      return [{ id: 999, name: 'never seen tag', nsfwLevel: 1, type: 'UserGenerated' }];
    });

    await processImageScanWorkflow({
      workflowId: 'workflow-with-an-unseen-tag',
      status: 'succeeded',
      imageId: 9,
      steps: [
        {
          $type: 'wdTagging',
          output: { tags: { 'never seen tag': 0.9 }, rating: { general: 0.9 } },
        },
        { $type: 'mediaRating', output: { nsfwLevel: 'pg', isBlocked: false } },
        { $type: 'mediaHash', output: { hashes: { perceptual: '6F51B11C49611E0E' } } },
      ] as any,
    });

    expect(tagInsert?.text).toContain('"updatedAt"');
    expect(tagInsert?.text).toContain('target');
    expect(tagInsert?.params.some((param) => param instanceof Date)).toBe(true);

    const written = mockInsertTagsOnImageNew.mock.calls.flatMap((call) => call[0]);
    expect(written.some((tag: any) => tag.imageId === 9 && tag.tagId === 999)).toBe(true);
  });

  describe('a throw while the image is still Pending', () => {
    const scanSteps = (tag: string) =>
      [
        { $type: 'wdTagging', output: { tags: { [tag]: 0.9 }, rating: { general: 0.9 } } },
        { $type: 'mediaRating', output: { nsfwLevel: 'pg', isBlocked: false } },
        { $type: 'mediaHash', output: { hashes: { perceptual: '6F51B11C49611E0E' } } },
      ] as any;

    it('terminalizes to Error with a bumped retryCount instead of leaving it Pending', async () => {
      const passthrough = mockDbWrite.$queryRaw.getMockImplementation();
      let markedError: { text: string; params: any[] } | undefined;

      mockDbWrite.$queryRaw.mockImplementation(async (query: any, ...values: any[]) => {
        const strings = Array.isArray(query) ? query : query.strings;
        const text = strings.join('');
        if (text.includes('INSERT INTO "Tag"')) throw new Error('Raw query failed. Code: `23502`.');
        if (text.includes('UPDATE "Image"') && text.includes("'{retryCount}'")) {
          markedError = renderSql(strings, values);
          return [{ retryCount: 1, mediaType: 'image', userId: 55 }];
        }
        return passthrough(query, ...values);
      });

      // Must resolve: rejecting 400s the webhook, and the orchestrator redelivers a
      // workflow that is already terminal.
      await expect(
        processImageScanWorkflow({
          workflowId: 'workflow-whose-processing-fails',
          status: 'succeeded',
          imageId: 10,
          steps: scanSteps('a tag that cannot be created'),
        })
      ).resolves.toBeUndefined();

      expect(markedError?.text).toContain(`'{retryCount}'`);
      expect(markedError?.params).toContain(ImageIngestionStatus.Error);
      expect(markedError?.params).toContain(10);
      const stamped = markedError?.params.find(
        (param) => typeof param === 'string' && param.includes('processing-failed')
      );
      expect(stamped).toBeDefined();
    });

    it('leaves a hard-blocked image Blocked rather than flipping it back to Error', async () => {
      const passthrough = mockDbWrite.$queryRaw.getMockImplementation();
      mockDbWrite.$queryRaw.mockImplementation(async (query: any, ...values: any[]) => {
        const strings = Array.isArray(query) ? query : query.strings;
        if (strings.join('').includes('INSERT INTO "Tag"'))
          throw new Error('Raw query failed. Code: `23502`.');
        return passthrough(query, ...values);
      });

      await expect(
        processImageScanWorkflow({
          workflowId: 'workflow-blocked-then-failing',
          status: 'succeeded',
          imageId: 13,
          steps: [
            {
              $type: 'wdTagging',
              output: { tags: { 'a tag that cannot be created': 0.9 }, rating: { general: 0.9 } },
            },
            {
              $type: 'mediaRating',
              output: { nsfwLevel: 'xxx', isBlocked: true, blockedReason: 'CSAM' },
            },
          ] as any,
        })
      ).resolves.toBeUndefined();

      // blockImageFromRating already persisted Blocked. markImageScanError is
      // unconditional, so running it here would un-block the image.
      const blocked = mockDbWrite.image.updateMany.mock.calls.find(
        (call: any) => call[0].where.id === 13
      );
      expect(blocked?.[0].data.ingestion).toBe(ImageIngestionStatus.Blocked);

      const errorFlips = mockDbWrite.$queryRaw.mock.calls.filter((call: any) => {
        const strings = Array.isArray(call[0]) ? call[0] : call[0]?.strings ?? [];
        return strings.join('').includes("'{retryCount}'");
      });
      expect(errorFlips).toHaveLength(0);
    });

    it('signals the Error state so the editor stops showing "Analyzing image"', async () => {
      const passthrough = mockDbWrite.$queryRaw.getMockImplementation();
      mockDbWrite.$queryRaw.mockImplementation(async (query: any, ...values: any[]) => {
        const strings = Array.isArray(query) ? query : query.strings;
        const text = strings.join('');
        if (text.includes('INSERT INTO "Tag"')) throw new Error('Raw query failed. Code: `23502`.');
        if (text.includes('UPDATE "Image"') && text.includes("'{retryCount}'"))
          return [{ retryCount: 1, mediaType: 'image', userId: 55 }];
        return passthrough(query, ...values);
      });

      await processImageScanWorkflow({
        workflowId: 'workflow-whose-processing-fails',
        status: 'succeeded',
        imageId: 14,
        steps: scanSteps('another tag that cannot be created'),
      });

      // Without this the editor keeps rendering Pending until the page is reloaded.
      expect(vi.mocked(signalClient.send)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 55,
          data: expect.objectContaining({ imageId: 14, ingestion: ImageIngestionStatus.Error }),
        })
      );
    });

    it('still surfaces a deleted image so the webhook can ACK it as skipped', async () => {
      mockDbWrite.image.findUnique.mockResolvedValue(null);

      await expect(
        processImageScanWorkflow({
          workflowId: 'workflow-for-a-deleted-image',
          status: 'succeeded',
          imageId: 11,
          steps: scanSteps('some tag'),
        })
      ).rejects.toThrow(/^image not found/);
    });
  });

  it('keeps a persisted verdict when a post-verdict side effect throws', async () => {
    mockDbWrite.$executeRaw.mockImplementation(async (query: any) => {
      const strings = Array.isArray(query) ? query : query.strings;
      if (strings.join('').includes('DELETE FROM "JobQueue"'))
        throw new Error('job queue delete failed');
      return 0;
    });

    await expect(
      processImageScanWorkflow({
        workflowId: 'workflow-with-a-failing-side-effect',
        status: 'succeeded',
        imageId: 12,
        steps: [
          { $type: 'wdTagging', output: { tags: { 'some-tag': 0.9 }, rating: { general: 0.9 } } },
          { $type: 'mediaRating', output: { nsfwLevel: 'pg', isBlocked: false } },
        ] as any,
      })
    ).resolves.toBeUndefined();

    const errorFlips = mockDbWrite.$queryRaw.mock.calls.filter((call: any) => {
      const strings = Array.isArray(call[0]) ? call[0] : call[0]?.strings ?? [];
      return strings.join('').includes("'{retryCount}'");
    });
    expect(errorFlips).toHaveLength(0);
  });

  // The imageScanning pipeline through the real shared stages; only the database, ClickHouse
  // and signals are faked. Scan outputs follow the shape the orchestrator returned on 2026-09-17.
  describe('imageScanning workflows through the shared pipeline', () => {
    const scanOutput = (overrides: Record<string, unknown> = {}) => ({
      nsfwLevel: 'x',
      score: 0.91,
      topK: [{ label: 'X', score: 0.91 }],
      aiRecognition: { label: 'AI', score: 0.86, topK: [] },
      animeRecognition: { label: 'anime', score: 0.9, scores: {} },
      humanRecognition: {
        status: 'ok',
        ran: true,
        label: 'human',
        score: 0.7,
        humanScore: 0.7,
        noHumanScore: 0.3,
        scores: {},
        evidence: [],
      },
      tagging: {
        status: 'ran',
        ran: true,
        threshold: 0.55,
        tagCount: 3,
        totalAboveThreshold: 3,
        truncated: false,
        tags: [
          { tag: 'teen', category: 'general', score: 0.9 },
          { tag: 'hate symbols', category: 'copyright', score: 0.8 },
          { tag: 'some-tag', category: 'meta', score: 0.8 },
        ],
      },
      jointAgeClassification: {
        status: 'ran',
        ran: true,
        detections: [{ ageBand: '21-24', under18Probability: 0.06, isMinor: false }],
        minorDetected: false,
      },
      csam: false,
      ...overrides,
    });
    const scanStep = (output: unknown, status = 'succeeded') => ({
      $type: 'imageScanning',
      name: 'scan',
      status,
      output,
    });
    const hashStep = {
      $type: 'mediaHash',
      name: 'hash',
      status: 'succeeded',
      output: { hashes: { perceptual: '6F51B11C49611E0E' } },
    };
    const deliver = (imageId: number, steps: unknown[], status = 'succeeded') =>
      processImageScanningWorkflow({ workflowId: `wf-${imageId}`, status, steps, imageId });

    const sqlOf = (call: any[]) =>
      renderSql(Array.isArray(call[0]) ? call[0] : call[0].strings, call.slice(1));
    // The verdict row written by resolveScanOutcome.
    const verdictFor = (imageId: number) => {
      const update = mockDbWrite.$executeRaw.mock.calls
        .map(sqlOf)
        .find(
          (sql: any) =>
            sql.text.includes('UPDATE "Image"') &&
            sql.text.includes('"needsReview"') &&
            sql.params.at(-1) === imageId
        );
      if (!update) return undefined;
      const param = (column: string) => {
        const match = update.text.match(new RegExp(`"${column}" = \\$(\\d+)`));
        return match ? update.params[Number(match[1]) - 1] : undefined;
      };
      return {
        ingestion: param('ingestion'),
        nsfwLevel: param('nsfwLevel'),
        needsReview: param('needsReview'),
        minor: param('minor'),
        pHash: param('pHash'),
      };
    };
    const tagsWritten = (imageId: number) =>
      mockInsertTagsOnImageNew.mock.calls
        .flatMap((call) => call[0])
        .filter((tag: any) => tag.imageId === imageId);
    const errorFlipsFor = (imageId: number) =>
      mockDbWrite.$queryRaw.mock.calls
        .map(sqlOf)
        .filter((sql: any) => sql.text.includes("'{retryCount}'") && sql.params.includes(imageId));
    const auditRows = () =>
      vi
        .mocked(clickhouse!.insert)
        .mock.calls.filter((call: any) => call[0].table === 'scanner_label_results')
        .flatMap((call: any) => call[0].values);

    beforeEach(() => {
      // An earlier test leaves $executeRaw throwing, which would skip the verdict write.
      mockDbWrite.$executeRaw.mockResolvedValue(0);
      vi.mocked(clickhouse!.insert).mockClear();
    });

    it('writes general tags, the rating and a Scanned verdict for an image', async () => {
      await deliver(40, [scanStep(scanOutput()), hashStep]);

      const written = tagsWritten(40);
      expect(written).toContainEqual(
        expect.objectContaining({ tagId: 200, source: TagSource.WD14, confidence: 90 })
      );
      expect(written).toContainEqual(
        expect.objectContaining({ tagId: 1004, source: TagSource.SpineRating })
      );
      // Other tagger categories are not ingested, even when the tag exists.
      expect(written.some((tag: any) => tag.tagId === 100 || tag.tagId === 400)).toBe(false);

      expect(verdictFor(40)).toMatchObject({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: 8,
        pHash: BigInt('0x6F51B11C49611E0E'),
      });
      expect(errorFlipsFor(40)).toHaveLength(0);
      expect(vi.mocked(signalClient.send)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ imageId: 40, ingestion: ImageIngestionStatus.Scanned }),
        })
      );
    });

    it('queues an NSFW image with a minor tag for review', async () => {
      await deliver(41, [scanStep(scanOutput())]);
      expect(verdictFor(41)).toMatchObject({ needsReview: 'minor', minor: true });
    });

    it('leaves a moderator-locked NSFW level alone', async () => {
      await deliver(7, [scanStep(scanOutput())]);
      expect(verdictFor(7)).toMatchObject({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: 1,
      });
    });

    it('writes version 2 scanner-audit rows, csam included', async () => {
      await deliver(42, [scanStep(scanOutput({ csam: true })), hashStep]);

      const rows = auditRows();
      expect(rows.map((row: any) => [row.label, row.labelValue, row.triggered])).toEqual([
        ['x', 'nsfw_level', 1],
        ['csam', '', 1],
        ['minor', '21-24', 0],
        ['ai', 'ai_recognition', 1],
        ['anime', 'anime_recognition', 1],
      ]);
      expect(rows.every((row: any) => row.version === '2' && row.entityIds[0] === '42')).toBe(true);
    });

    it('rates a video by its riskiest frame', async () => {
      await deliver(43, [
        { $type: 'videoFrameExtraction', name: 'videoFrames', status: 'succeeded', output: {} },
        {
          $type: 'repeat',
          status: 'succeeded',
          input: { template: { $type: 'imageScanning' } },
          output: {
            steps: [
              scanStep(scanOutput({ nsfwLevel: 'pg' })),
              scanStep(scanOutput({ nsfwLevel: 'x' })),
              scanStep(scanOutput({ nsfwLevel: 'pg13' })),
            ],
          },
        },
      ]);

      expect(tagsWritten(43)).toContainEqual(
        expect.objectContaining({ tagId: 1004, source: TagSource.SpineRating })
      );
      expect(verdictFor(43)).toMatchObject({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: 8,
      });
    });

    it.each([
      ['a failed workflow', [scanStep(undefined, 'failed')], 'failed', 'workflow-failed'],
      [
        'a scan whose tagging did not run',
        [scanStep(scanOutput({ tagging: { status: 'skipped', ran: false, tags: [] } }))],
        'succeeded',
        'unusable-result',
      ],
    ])('marks %s as one Error without a verdict', async (_, steps, status, failureType) => {
      await deliver(44, steps, status);

      const flips = errorFlipsFor(44);
      expect(flips).toHaveLength(1);
      expect(flips[0].params.join(' ')).toContain(failureType);
      expect(verdictFor(44)).toBeUndefined();
      expect(tagsWritten(44)).toHaveLength(0);
    });
  });
});
