import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two detail endpoints a model-flag row opens: neither may send a withheld cover's key to a
 * moderator without the CSAM grant. The withheld read has no database here, so it fails and
 * withholds every image, which is what a moderator without the grant must then get.
 */

const grants = vi.hoisted(() => ({ paths: new Set<string>() }));
vi.mock('$lib/server/access', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canAccess: (_user: unknown, path: string) => grants.paths.has(path),
}));
vi.mock('$lib/server/minor-queue-access', () => ({ canAccessMinorQueue: () => true }));
vi.mock('$lib/server/db', () => ({
  dbRead: {},
  dbWrite: {
    transaction: () => ({ execute: async () => Promise.reject(new Error('no database')) }),
  },
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(async () => {}) }));
const previews = vi.hoisted(() => ({ getModelPreview: vi.fn() }));
vi.mock('$lib/server/model-preview.service', () => previews);
const hash = vi.hoisted(() => ({
  getMinorHashMatchDetail: vi.fn(),
  getAutoFlaggedMinorDetail: vi.fn(),
}));
vi.mock('$lib/server/minor-hash.service', () => hash);

const previewRoute = await import('../model-preview/[modelId]/+server');
const hashRoute = await import('../minor-hash-detail/[modelId]/+server');
const { MODEL_FLAGS_APPEALS_PATH } = await import('$lib/minor-flags/paths');

const IMAGE = 990000701;
const COVER = 990000702;
const user = { id: 2, roles: [] };

const call = async (route: { GET: unknown }, query = '') =>
  (
    await (route.GET as (e: unknown) => Promise<Response>)({
      params: { modelId: '5' },
      url: new URL(`http://mod.test/api/x/5${query}`),
      locals: { user, grants: {} },
    })
  ).json();

const detail = {
  modelCoverId: COVER,
  modelCoverUrl: 'cover-key',
  modelCoverType: 'image',
  minorModelCoverId: null,
  minorModelCoverUrl: null,
  minorModelCoverType: null,
};

beforeEach(() => {
  grants.paths = new Set([MODEL_FLAGS_APPEALS_PATH]);
  previews.getModelPreview.mockResolvedValue({
    id: 5,
    images: [
      {
        id: IMAGE,
        url: 'image-key',
        type: 'image',
        nsfwLevel: 1,
        blocked: false,
        minor: true,
        acceptableMinor: false,
      },
    ],
  });
  hash.getMinorHashMatchDetail.mockResolvedValue(detail);
  hash.getAutoFlaggedMinorDetail.mockResolvedValue({ match: null, detail });
});

describe('the model preview endpoint', () => {
  it('sends a withheld image with no key or flag', async () => {
    const body = await call(previewRoute);
    expect(body.images).toEqual([
      {
        id: IMAGE,
        url: '',
        type: 'image',
        nsfwLevel: 1,
        blocked: false,
        minor: false,
        acceptableMinor: false,
        restricted: true,
      },
    ]);
  });
});

describe('the file-match detail endpoint', () => {
  it.each([
    ['with the seed named', '?minorModelId=9'],
    ['resolving the seed', ''],
  ])('sends a withheld cover with no key, %s', async (_, query) => {
    const body = await call(hashRoute, query);
    expect(body.detail).toMatchObject({
      modelCoverId: null,
      modelCoverUrl: null,
      modelCoverType: null,
      modelCoverWithheld: true,
    });
    expect(JSON.stringify(body)).not.toContain('cover-key');
  });
});
