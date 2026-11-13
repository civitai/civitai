import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import { childBrowsingTagIds, peopleBrowsingTagIds } from '@civitai/shared';
import { NsfwLevel } from '~/server/common/enums';
import { DEFAULT_BROWSING_SETTINGS_ADDONS } from '~/shared/constants/browsing-settings-addons';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * GET /api/v1/model-versions/[id], GET by-hash/[hash] and POST by-hash serve a version's showcase
 * at the request's level, with the browsing-settings exclusions (tags, poi, minor) resolved at that
 * level, and keep out of the shared cache any body a caller in another region could see differently.
 * The exclusions are the real `getShowcaseImageFilter` over the default browsing-settings addons.
 */

const mockGetImages = vi.hoisted(() => vi.fn());

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBlockedBrowsingTags: async () => [],
  getBrowsingSettingAddons: async () => DEFAULT_BROWSING_SETTINGS_ADDONS,
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelVersionPrivacyRow: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/model.service', () => ({
  getVaeFiles: async () => [],
  holdShowcaseImages: async (byVersion: unknown) => byVersion,
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: mockGetImages,
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: async () => ({}),
  getPublicPaidAccessForModelVersions: async () => ({}),
  toPublicPaidAccessDto: () => null,
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembershipCached: async () => false,
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: any) => `${file.id}.safetensors`,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/services/training-data-restricted.service', () => ({
  trainingDataListing: async () => () => true,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => handler,
  PublicEndpoint: (handler: any) => handler,
}));
const region = vi.hoisted(() => ({ restricted: false }));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'XX',
  isRegionRestricted: () => region.restricted,
}));

const VERSION = 4242;
const CHILD_TAG = childBrowsingTagIds[0];
const PEOPLE_TAG = peopleBrowsingTagIds[0];

type Fixture = { id: number; nsfwLevel: number; tags?: number[]; poi?: boolean; minor?: boolean };
const image = ({ id, nsfwLevel, tags = [], poi = false, minor = false }: Fixture) => ({
  id,
  nsfwLevel,
  tags,
  poi,
  minor,
  url: `u${id}`,
  userId: 7,
  name: null,
  modelVersionId: VERSION,
  type: 'image',
  width: 1,
  height: 1,
  hash: null,
  meta: null,
});

const UNTAGGED_PG = image({ id: 1, nsfwLevel: NsfwLevel.PG });
const CHILD_R = image({ id: 2, nsfwLevel: NsfwLevel.R, tags: [CHILD_TAG] });
const POI_R = image({ id: 3, nsfwLevel: NsfwLevel.R, poi: true });
const MINOR_R = image({ id: 4, nsfwLevel: NsfwLevel.R, minor: true });
const PEOPLE_PG = image({ id: 5, nsfwLevel: NsfwLevel.PG, tags: [PEOPLE_TAG] });
const UNTAGGED_R = image({ id: 6, nsfwLevel: NsfwLevel.R });
const UNTAGGED_PG13 = image({ id: 7, nsfwLevel: NsfwLevel.PG13 });
const CHILD_PG = image({ id: 8, nsfwLevel: NsfwLevel.PG, tags: [CHILD_TAG] });

let showcase: ReturnType<typeof image>[] = [];

/** As the SQL does: only the requested levels, and tags only when asked for. */
function fakeGetImages({
  browsingLevel,
  include = [],
}: {
  browsingLevel?: number;
  include?: string[];
}) {
  return showcase
    .filter((i) => !browsingLevel || (i.nsfwLevel & browsingLevel) !== 0)
    .map(({ tags, ...i }) => (include.includes('tags') ? { ...i, tags } : i));
}

function modelVersion(nsfwLevel: number) {
  return {
    id: VERSION,
    modelId: 77,
    name: 'v1',
    baseModel: 'SD 1.5',
    status: 'Published',
    availability: 'Public',
    nsfwLevel,
    licensingFee: null,
    files: [
      {
        id: 21,
        type: 'Model',
        visibility: 'Public',
        sizeKB: 1,
        modelVersionId: VERSION,
        url: 's3://a',
        name: 'a.safetensors',
        hashes: [{ type: 'SHA256', hash: 'A'.repeat(64) }],
        metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
      },
    ],
    metrics: [],
    model: {
      name: 'M',
      type: 'LORA',
      nsfw: false,
      poi: false,
      mode: null,
      availability: 'Public',
      userId: 7,
      minor: false,
      sfwOnly: false,
    },
  } as any;
}

function fakeRes() {
  return {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as any,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

type Route = 'id' | 'by-hash' | 'by-hash batch';

async function call(route: Route, host: string) {
  const res = fakeRes();
  const headers = { host };
  if (route === 'id') {
    const handler = (await import('~/pages/api/v1/model-versions/[id]')).default as any;
    await handler({ method: 'GET', query: { id: String(VERSION), nsfw: 'true' }, headers }, res);
    return { res, version: res.body };
  }
  if (route === 'by-hash') {
    const handler = (await import('~/pages/api/v1/model-versions/by-hash/[hash]')).default as any;
    await handler({ method: 'GET', query: { hash: 'a'.repeat(64), nsfw: 'true' }, headers }, res);
    return { res, version: res.body };
  }
  const handler = (await import('~/pages/api/v1/model-versions/by-hash')).default as any;
  await handler({ method: 'POST', query: {}, body: ['A'.repeat(64)], headers }, res);
  return { res, version: res.body?.[0] };
}

function serve(versionNsfwLevel: number, images: ReturnType<typeof image>[]) {
  showcase = images;
  const version = modelVersion(versionNsfwLevel);
  dbMock.dbRead.$queryRaw.mockResolvedValue([version]);
  dbMock.dbRead.modelFile.findFirst.mockResolvedValue({ modelVersion: version });
  dbMock.dbRead.modelFile.findMany.mockResolvedValue([{ modelVersion: version }]);
}

const servedIds = (version: any) => version.images.map((i: any) => Number(i.url.slice(1)));
const noStore = (res: ReturnType<typeof fakeRes>) =>
  res.headers['Cache-Control'] === 'private, no-store';

const MIXED = [UNTAGGED_PG, CHILD_R, POI_R, MINOR_R, PEOPLE_PG, UNTAGGED_R];
const ROUTES: Route[] = ['id', 'by-hash', 'by-hash batch'];
const HOSTS = ['civitai.com', 'civitai.red'];

beforeEach(() => {
  vi.clearAllMocks();
  region.restricted = false;
  mockGetImages.mockImplementation(async (args: any) => fakeGetImages(args));
});

describe.each(ROUTES)('%s, anonymous', (route) => {
  describe.each(HOSTS)('on %s', (host) => {
    it('serves no child-tagged R+, poi, minor or people-tagged image; untagged ones stay', async () => {
      serve(NsfwLevel.PG | NsfwLevel.R, MIXED);
      const { res, version } = await call(route, host);
      expect(res.statusCode).toBe(200);
      expect(servedIds(version)).toEqual([UNTAGGED_PG.id, UNTAGGED_R.id]);
      expect(version.images[0]).not.toHaveProperty('tags');
    });

    it('serves a region held to SFW only its SFW images', async () => {
      region.restricted = true;
      serve(NsfwLevel.PG | NsfwLevel.R, MIXED);
      const { version } = await call(route, host);
      expect(servedIds(version)).toEqual([UNTAGGED_PG.id]);
    });
  });

  describe('the shared cache', () => {
    it.each([false, true])(
      'keeps out a version above SFW, for either region (restricted: %s)',
      async (restricted) => {
        region.restricted = restricted;
        serve(NsfwLevel.PG | NsfwLevel.R, [UNTAGGED_PG, UNTAGGED_R]);
        const { res } = await call(route, 'civitai.com');
        expect(noStore(res)).toBe(true);
      }
    );

    it.each([false, true])(
      'keeps out an SFW version whose exclusions differ by level (restricted: %s)',
      async (restricted) => {
        region.restricted = restricted;
        serve(NsfwLevel.PG, [UNTAGGED_PG, CHILD_PG]);
        const { res } = await call(route, 'civitai.com');
        expect(noStore(res)).toBe(true);
      }
    );

    it.each([false, true])(
      'keeps an SFW version whose exclusions agree at both levels (restricted: %s)',
      async (restricted) => {
        region.restricted = restricted;
        // The people-tagged image is excluded at every level, so it changes nothing by region.
        serve(NsfwLevel.PG | NsfwLevel.PG13, [UNTAGGED_PG, UNTAGGED_PG13, PEOPLE_PG]);
        const { res, version } = await call(route, 'civitai.com');
        expect(noStore(res)).toBe(false);
        expect(servedIds(version)).toEqual([UNTAGGED_PG.id, UNTAGGED_PG13.id]);
      }
    );
  });
});
