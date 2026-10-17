import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import type * as UserService from '~/server/services/user.service';
import type * as ImageQueries from '@civitai/db-queries/image';

/**
 * Parity gate for the port of `getImageGenerationData`'s image read from Prisma to Kysely.
 *
 * Runs the WHOLE function twice over the same rows in the same database: once as shipped (the
 * Kysely query over `kyselyRead`), once with the image read swapped back to the Prisma
 * `image.findUnique` it replaced, copied verbatim below. Everything else — the visibility and
 * source-media checks, the resource cache, the meta handling — is the same code in both arms, so
 * any difference in the response is the port's. Each response is compared twice: structurally
 * with `toStrictEqual` (catches `undefined` vs a missing key) and as its serialized JSON (catches
 * key ORDER, which `toEqual` ignores and the wire payload does not).
 *
 * Opt-in via `KYSELY_PARITY_DATABASE_URL`, which must point at a THROWAWAY database: the suite
 * drops and recreates its tables. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 *   docker run -d --rm --name pg-parity -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=parity \
 *     -p 54329:5432 postgres:17
 *   KYSELY_PARITY_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/parity \
 *     pnpm vitest run --project unit src/server/services/__tests__/image-generation-data.kysely-parity.test.ts
 */

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(),
}));

// `kyselyRead` is a real client on the parity database. Every other tier throws on use, so a read
// routed to the writer or a long-read replica fails here instead of silently returning the same
// rows (in production those are different servers with different lag).
vi.mock('~/server/db/kyselyDb', async () => {
  const { createKyselyClients } = await import('@civitai/db/kysely');
  const url = process.env.KYSELY_PARITY_DATABASE_URL;
  const wrongTier = (name: string) =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol' || prop === 'then') return undefined;
          throw new Error(`getImageGenerationData read through ${name}; it must use kyselyRead`);
        },
      }
    );
  return {
    kyselyRead: url
      ? createKyselyClients({ connectionString: url, singleClient: true }).db
      : wrongTier('kyselyRead (no KYSELY_PARITY_DATABASE_URL)'),
    kyselyWrite: wrongTier('kyselyWrite'),
    kyselyReadLong: wrongTier('kyselyReadLong'),
    kyselyDatapacket: wrongTier('kyselyDatapacket'),
  };
});

// Passes straight through to the real query by default; the Prisma arm swaps the implementation.
vi.mock('@civitai/db-queries/image', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageQueries>();
  return { ...actual, getImageGenerationFields: vi.fn(actual.getImageGenerationFields) };
});

import { getImageGenerationFields } from '@civitai/db-queries/image';
import { kyselyRead } from '~/server/db/kyselyDb';
import { imageResourcesCache } from '~/server/redis/caches';
import type { ImageResourceCacheItem } from '~/server/redis/caches';
import { getImageGenerationData } from '../image.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import type { MediaViewer } from '~/server/utils/image-media-visibility';

const parityUrl = process.env.KYSELY_PARITY_DATABASE_URL;
const imageRead = vi.mocked(getImageGenerationFields);
const { getImageGenerationFields: realImageRead } = await vi.importActual<typeof ImageQueries>(
  '@civitai/db-queries/image'
);

const schemaStatements = loadParitySchema(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/image-generation-data-parity-schema.sql'
  )
);

const OWNER = 10;
const OTHER = 20;
const MANAGER = 30;
const SOURCE_OWNER = 40;
const BLOCKED = 50;
const SOURCE = 'https://image.example/source.png';

type Viewer = {
  label: string;
  userId?: number;
  isModerator?: boolean;
  canViewNsfw: boolean;
  crawler?: boolean;
};
const VIEWERS: Viewer[] = [
  { label: 'signed out, SFW domain', canViewNsfw: false },
  { label: 'signed out, mature domain', canViewNsfw: true },
  { label: 'a crawler, SFW domain', canViewNsfw: false, crawler: true },
  { label: 'a crawler, mature domain', canViewNsfw: true, crawler: true },
  { label: 'another user, SFW domain', userId: OTHER, canViewNsfw: false },
  { label: 'another user, mature domain', userId: OTHER, canViewNsfw: true },
  { label: 'the owner, SFW domain', userId: OWNER, canViewNsfw: false },
  { label: 'a moderator, SFW domain', userId: OTHER, isModerator: true, canViewNsfw: false },
  { label: "a manager of the post's collection, SFW domain", userId: MANAGER, canViewNsfw: false },
  { label: "the source image's owner, SFW domain", userId: SOURCE_OWNER, canViewNsfw: false },
  { label: 'a user the owner blocked, mature domain', userId: BLOCKED, canViewNsfw: true },
];

function ctxFor(viewer: Viewer) {
  return {
    user: viewer.userId ? { id: viewer.userId, isModerator: viewer.isModerator } : undefined,
    features: { canViewNsfw: viewer.canViewNsfw },
    req: { headers: viewer.crawler ? { 'x-civitai-verified-bot': 'googlebot' } : {} },
    cache: { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30 },
  } as unknown as MediaViewer;
}

const resource = (
  imageId: number,
  over: Partial<ImageResourceCacheItem> & Pick<ImageResourceCacheItem, 'modelVersionId'>
): ImageResourceCacheItem => ({
  imageId,
  strength: null,
  detected: false,
  modelId: over.modelVersionId * 10,
  modelName: `Model ${over.modelVersionId}`,
  modelType: 'Checkpoint',
  versionName: `v${over.modelVersionId}`,
  baseModel: 'SDXL 1.0',
  poi: false,
  minor: false,
  ...over,
});

// Resources come from a cache this port does not touch; both arms are handed the same ones so the
// resource-dependent branches (strength scaling, on-site display keys) run in each.
const RESOURCES: Record<number, ImageResourceCacheItem[]> = {
  1: [
    resource(1, { modelVersionId: 1 }),
    resource(1, { modelVersionId: 2, modelType: 'LORA', strength: 80 }),
    resource(1, { modelVersionId: 3, modelType: 'TextualInversion', strength: 0 }),
  ],
  5: [
    resource(5, { modelVersionId: 4 }),
    resource(5, { modelVersionId: 5, modelType: 'DoRA', strength: 55 }),
  ],
  7: [resource(7, { modelVersionId: 6, modelType: 'LoCon', strength: 100 })],
};

/** Every image the matrix runs, with what makes it distinct. */
const IMAGES: Array<[label: string, id: number]> = [
  ['with meta, resources, ordered tools and techniques', 1],
  ['with no meta, tools or techniques (a video)', 2],
  ['with hidden meta', 3],
  ['whose meta does not parse', 4],
  ['generated on site with a comfy graph and ControlNets', 5],
  ['rated R, with media links in its meta', 6],
  ['made from an R-rated source image', 7],
  ['awaiting review', 9],
  ['rated Blocked', 10],
  ['with no post', 11],
  ['whose meta is a JSON null', 12],
  ['with an engine-recorded process', 13],
  ['that does not exist', 999],
];

/** The Prisma read the port replaced, VERBATIM from image.service.ts before the port. */
const viaPrisma = (prisma: PrismaClient, id: number) =>
  prisma.image.findUnique({
    where: { id },
    select: {
      hideMeta: true,
      generationProcess: true,
      meta: true,
      type: true,
      tools: {
        orderBy: { tool: { priority: 'asc' } },
        select: {
          notes: true,
          tool: {
            select: {
              id: true,
              name: true,
              icon: true,
              domain: true,
              priority: true,
            },
          },
        },
      },
      techniques: {
        select: {
          notes: true,
          technique: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

describe.skipIf(!parityUrl)('getImageGenerationData: Kysely image read matches Prisma', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl });
  const prismaFindUnique = vi.spyOn(prisma.image, 'findUnique');

  beforeAll(async () => {
    for (const statement of schemaStatements) await prisma.$executeRawUnsafe(statement);

    const json = (value: unknown) =>
      `'${JSON.stringify(value)
        .replace('"__BIG_SEED__"', '18446744073709551615')
        .replace('"__DECIMAL__"', '0.50')
        .replace(/'/g, "''")}'::jsonb`;
    const RICH_META = {
      prompt: 'a lighthouse at dusk, “quoted”, ünïcødé',
      negativePrompt: 'blurry',
      cfgScale: 7,
      steps: 30,
      sampler: 'DPM++ 2M Karras',
      seed: 3141592653,
      // Spliced in as raw JSON text below: a 64-bit seed past 2^53 and a decimal with a trailing
      // zero, which a JS literal could not carry into the row unchanged.
      bigSeed: '__BIG_SEED__',
      denoise: '__DECIMAL__',
      'Clip skip': 2,
      Size: '832x1216',
      'Hires upscale': 1.5,
      external: { source: { name: 'Tool', homepage: 'https://tool.example' } },
      extra: { remixOfId: 77 },
    };
    const ON_SITE_META = {
      prompt: 'an on-site comfy generation',
      civitaiResources: [{ modelVersionId: 4 }, { modelVersionId: 5, strength: 0.55 }],
      comfy: JSON.stringify({ prompt: { '1': { inputs: { image: `${SOURCE}?comfy` } } } }),
      controlNets: [`${SOURCE}?controlnet`],
      workflow: 'txt2img',
      clipSkip: 1,
      extra: { sourceImageIds: [6, 5, 6] },
    };
    const MEDIA_META = {
      prompt: 'with media',
      images: [{ url: SOURCE, width: 512, height: 512 }],
      video: { url: `${SOURCE}?video` },
      styleReferences: [{ image: { URL: 'image-key' }, strength: 1 }],
      mask: 'data:image/png;base64,AAAA',
      ControlNet: 'on',
    };
    const EDIT_META = {
      prompt: 'an edit',
      workflow: 'img2img:edit',
      images: [{ url: SOURCE, width: 512, height: 512 }],
      extra: { sourceImageIds: [8] },
    };

    await prisma.$executeRawUnsafe(`
      INSERT INTO "Post" (id, "userId", "publishedAt", "collectionId") VALUES
        (1, ${OWNER}, now() - interval '1 day', 7),
        (2, ${SOURCE_OWNER}, now() - interval '1 day', NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "CollectionContributor" ("userId", "collectionId", permissions) VALUES
        (${MANAGER}, 7, ARRAY['MANAGE']::"CollectionContributorPermission"[])
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Image" (id, "userId", "postId", meta, type, "nsfwLevel", "generationProcess",
        "needsReview", "hideMeta", ingestion) VALUES
        (1, ${OWNER}, 1, ${json(RICH_META)}, 'image', 1, 'txt2imgHiRes', NULL, false, 'Scanned'),
        (2, ${OWNER}, 1, NULL, 'video', 2, 'img2img', NULL, false, 'Scanned'),
        (3, ${OWNER}, 1, ${json(RICH_META)}, 'image', 1, 'txt2img', NULL, true, 'Scanned'),
        (4, ${OWNER}, 1, ${json([
      1,
      'two',
      { three: 3 },
    ])}, 'image', 1, NULL, NULL, false, 'Scanned'),
        (5, ${OWNER}, 1, ${json(ON_SITE_META)}, 'image', 1, NULL, NULL, false, 'Scanned'),
        (6, ${OWNER}, 1, ${json(MEDIA_META)}, 'image', 4, 'inpainting', NULL, false, 'Scanned'),
        (7, ${OWNER}, 1, ${json(EDIT_META)}, 'image', 1, 'img2img', NULL, false, 'Scanned'),
        (8, ${SOURCE_OWNER}, 2, ${json({
      prompt: 'the source',
    })}, 'image', 4, NULL, NULL, false, 'Scanned'),
        (9, ${OWNER}, 1, ${json({
      prompt: 'under review',
    })}, 'image', 1, NULL, 'minor', false, 'Scanned'),
        (10, ${OWNER}, 1, ${json({
      prompt: 'blocked',
    })}, 'image', 32, NULL, NULL, false, 'Scanned'),
        (11, ${OWNER}, NULL, ${json({
      prompt: 'postless',
    })}, 'image', 1, NULL, NULL, false, 'Scanned'),
        (12, ${OWNER}, 1, 'null'::jsonb, 'audio', 1, 'txt2img', NULL, false, 'Scanned'),
        (13, ${OWNER}, 1, ${json({
      prompt: 'a clip',
      engine: 'veo3',
      type: 'txt2vid',
    })}, 'video', 1, NULL, NULL, false, 'Scanned'),
        (14, ${OWNER}, 1, ${json({ prompt: 'ties' })}, 'image', 1, NULL, NULL, false, 'Scanned')
    `);
    // Distinct priorities on image 1 (and a single null, which sorts last), so its tool order is
    // fully determined on both paths; one tool disabled and unlisted, which neither path filters.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Tool" (id, name, icon, domain, priority, type, enabled, unlisted) VALUES
        (1, 'Alpha', 'alpha.png', 'alpha.example', 3, 'Image', true, false),
        (2, 'Bravo', NULL, NULL, 1, 'Image', true, false),
        (3, 'Charlie', 'charlie.png', NULL, NULL, 'Video', true, false),
        (4, 'Delta (retired)', NULL, 'delta.example', 2, 'Editor', false, true),
        (5, 'Echo', NULL, NULL, 5, 'Image', true, false),
        (6, 'Foxtrot', NULL, NULL, 5, 'Image', true, false),
        (7, 'Golf', NULL, NULL, NULL, 'Image', true, false)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Technique" (id, name, type, enabled) VALUES
        (1, 'txt2img', 'Image', true), (2, 'inpainting', 'Image', true), (3, 'retired', 'Video', false)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ImageTool" ("imageId", "toolId", notes) VALUES
        (1, 3, 'last: null priority'), (1, 1, NULL), (1, 4, 'disabled tool'), (1, 2, 'first'),
        (5, 1, NULL), (6, 2, 'r-rated'), (7, 3, NULL),
        (8, 1, 'source image tool'),
        (14, 6, 'tie a'), (14, 5, 'tie b'), (14, 7, 'null a'), (14, 3, 'null b'), (14, 2, 'first')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ImageTechnique" ("imageId", "techniqueId", notes) VALUES
        (1, 2, 'masked'), (1, 3, NULL), (5, 1, NULL), (6, 2, 'r-rated'), (8, 1, 'source')
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await (kyselyRead as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(() => {
    // Visibility, collection-manager and source checks are raw SQL on dbRead: run them for real.
    (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
        prisma.$queryRaw(first as never, ...values)
    );
    vi.mocked(amIBlockedByUser)
      .mockReset()
      .mockImplementation(async ({ userId }) => userId === BLOCKED);
    vi.spyOn(imageResourcesCache, 'fetch').mockImplementation(async (ids) => {
      const out: Record<number, { imageId: number; resources: ImageResourceCacheItem[] }> = {};
      for (const id of [ids].flat() as number[])
        if (RESOURCES[id]) out[id] = { imageId: id, resources: RESOURCES[id] };
      return out;
    });
    imageRead.mockReset().mockImplementation(realImageRead);
    prismaFindUnique.mockClear();
  });

  type Outcome =
    | { ok: true; data: Awaited<ReturnType<typeof getImageGenerationData>>; cache: unknown }
    | { ok: false; code: string | undefined };

  async function run(id: number, viewer: Viewer): Promise<Outcome> {
    const ctx = ctxFor(viewer);
    try {
      const data = await getImageGenerationData({ id, viewer: ctx });
      return { ok: true, data, cache: { ...ctx.cache } };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'NOT_FOUND') throw e;
      return { ok: false, code };
    }
  }

  /** The function as shipped, then with the image read swapped back to Prisma. */
  async function bothArms(id: number, viewer: Viewer) {
    imageRead.mockClear();
    prismaFindUnique.mockClear();
    imageRead.mockImplementation(realImageRead);
    const kysely = await run(id, viewer);
    const kyselyCalls = imageRead.mock.calls.length;
    const prismaCallsDuringKysely = prismaFindUnique.mock.calls.length;

    imageRead.mockImplementation((_db, imageId) => viaPrisma(prisma, imageId as number));
    const prismaOut = await run(id, viewer);

    // Each arm ran the read it claims to: an arm that silently took the other path would compare
    // a result with itself.
    expect(prismaCallsDuringKysely).toBe(0);
    expect(prismaFindUnique.mock.calls.length).toBe(imageRead.mock.calls.length - kyselyCalls);
    for (const [db] of imageRead.mock.calls) expect(db).toBe(kyselyRead);
    return { kysely, prisma: prismaOut };
  }

  // Techniques have no ORDER BY on either path (as in the source), so their order is not part of
  // the contract. Everything else, key order included, is compared as returned.
  const withSortedTechniques = (outcome: Outcome): Outcome =>
    outcome.ok
      ? {
          ...outcome,
          data: {
            ...outcome.data,
            techniques: [...outcome.data.techniques].sort((a, b) => a.id - b.id),
          },
        }
      : outcome;

  function expectSame(kysely: Outcome, prismaOut: Outcome) {
    const [k, p] = [withSortedTechniques(kysely), withSortedTechniques(prismaOut)];
    expect(k).toStrictEqual(p);
    expect(JSON.stringify(k)).toBe(JSON.stringify(p));
  }

  describe.each(IMAGES)('an image %s', (_label, id) => {
    it.each(VIEWERS.map((v) => [v.label, v] as const))(
      'returns the same response to %s',
      async (_viewerLabel, viewer) => {
        const { kysely, prisma: prismaOut } = await bothArms(id, viewer);
        expectSame(kysely, prismaOut);
      }
    );
  });

  // Positive controls: the matrix above compares like with like, so it would also pass if both
  // arms returned nothing. These pin that the rows it compares carry the fields under test.
  it('carries the ordered tools, techniques and resources of the rich image', async () => {
    const { kysely, prisma: prismaOut } = await bothArms(1, VIEWERS[1]);
    expectSame(kysely, prismaOut);
    if (!kysely.ok) throw new Error('image 1 must be visible to a signed-out viewer');
    expect(kysely.data.tools).toStrictEqual([
      { id: 2, name: 'Bravo', icon: null, domain: null, priority: 1, notes: 'first' },
      {
        id: 4,
        name: 'Delta (retired)',
        icon: null,
        domain: 'delta.example',
        priority: 2,
        notes: 'disabled tool',
      },
      {
        id: 1,
        name: 'Alpha',
        icon: 'alpha.png',
        domain: 'alpha.example',
        priority: 3,
        notes: null,
      },
      {
        id: 3,
        name: 'Charlie',
        icon: 'charlie.png',
        domain: null,
        priority: null,
        notes: 'last: null priority',
      },
    ]);
    expect([...kysely.data.techniques].sort((a, b) => a.id - b.id)).toStrictEqual([
      { id: 2, name: 'inpainting', notes: 'masked' },
      { id: 3, name: 'retired', notes: null },
    ]);
    expect(kysely.data.meta?.prompt).toContain('lighthouse');
    expect(kysely.data.process).toBe('txt2img + Hi-Res');
    expect(kysely.data.resources.map((r) => r.strength)).toEqual([undefined, 0.8, undefined]);
    expect(kysely.data.remixOfId).toBe(77);
  });

  it('withholds and keeps media identically, and both arms see the media', async () => {
    const sfw = await bothArms(6, VIEWERS[0]);
    const owner = await bothArms(6, VIEWERS[6]);
    expectSame(sfw.kysely, sfw.prisma);
    expectSame(owner.kysely, owner.prisma);
    expect(JSON.stringify(sfw.kysely)).not.toContain(SOURCE);
    expect(JSON.stringify(owner.kysely)).toContain(SOURCE);
  });

  it('agrees on NOT_FOUND for hidden, blocked and missing images', async () => {
    for (const [id, viewer] of [
      [9, VIEWERS[5]],
      [10, VIEWERS[0]],
      [11, VIEWERS[5]],
      [999, VIEWERS[7]],
      [1, VIEWERS[10]],
    ] as const) {
      const { kysely, prisma: prismaOut } = await bothArms(id, viewer);
      expect(kysely).toStrictEqual({ ok: false, code: 'NOT_FOUND' });
      expectSame(kysely, prismaOut);
    }
  });

  // Ties in `Tool.priority` (including several nulls) have no defined order on either path — the
  // Prisma query orders by priority alone — so for those the order WITHIN a tie is compared as a
  // set, and the order BETWEEN priority groups exactly.
  it('orders tools by priority, nulls last, with ties unordered on both paths', async () => {
    const { kysely, prisma: prismaOut } = await bothArms(14, VIEWERS[1]);
    if (!kysely.ok || !prismaOut.ok) throw new Error('image 14 must be visible');
    const groups = (tools: { id: number; priority: number | null }[]) =>
      tools.reduce<Array<{ priority: number | null; ids: number[] }>>((acc, tool) => {
        const last = acc[acc.length - 1];
        if (last && last.priority === tool.priority) last.ids.push(tool.id);
        else acc.push({ priority: tool.priority, ids: [tool.id] });
        return acc;
      }, []);
    const normalise = (tools: { id: number; priority: number | null }[]) =>
      groups(tools).map((g) => ({ ...g, ids: [...g.ids].sort((a, b) => a - b) }));
    expect(normalise(kysely.data.tools)).toStrictEqual([
      { priority: 1, ids: [2] },
      { priority: 5, ids: [5, 6] },
      { priority: null, ids: [3, 7] },
    ]);
    expect(normalise(kysely.data.tools)).toStrictEqual(normalise(prismaOut.data.tools));
    const byId = (tools: { id: number }[]) => [...tools].sort((a, b) => a.id - b.id);
    expect(byId(kysely.data.tools)).toStrictEqual(byId(prismaOut.data.tools));
  });

  // The query on its own, outside the function: the row the caller receives, byte for byte.
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 999])(
    'image %i: the raw row matches Prisma, including key order and null for a missing image',
    async (id) => {
      const [kysely, prismaRow] = await Promise.all([
        realImageRead(kyselyRead, id),
        viaPrisma(prisma, id),
      ]);
      const sortTechniques = <T extends { techniques: { technique: { id: number } }[] } | null>(
        row: T
      ) =>
        row && {
          ...row,
          techniques: [...row.techniques].sort((a, b) => a.technique.id - b.technique.id),
        };
      expect(sortTechniques(kysely)).toStrictEqual(sortTechniques(prismaRow));
      expect(JSON.stringify(sortTechniques(kysely))).toBe(
        JSON.stringify(sortTechniques(prismaRow))
      );
      if (id === 999) expect(kysely).toBeNull();
      // Positive control: the precision probes really are in the row being compared.
      if (id === 1) {
        const meta = kysely?.meta as Record<string, unknown>;
        expect(meta.bigSeed).toBe(2 ** 64); // what 18446744073709551615 parses to as a double
        expect(meta.denoise).toBe(0.5);
      }
    }
  );
});
