import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Folding `images` back into removeEmpty turns these red: the public docs promise `images: []`.

const { mockGetModelsWithVersions } = vi.hoisted(() => ({
  mockGetModelsWithVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
}));

vi.mock('~/server/services/model-version.service', () => ({
  publicModelResponseKey: (id: number, browsingLevel: number) =>
    `packed:caches:public-model-response:${id}:${browsingLevel}`,
}));

vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: vi.fn() }));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => handler(req, res),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => (req: any, res: any) => handler(req, res),
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));

// IS_DATAPACKET false ⇒ PUBLIC_MODEL_RESPONSE_TTL = 0 ⇒ every request builds
// directly (no cache), which is what we want to observe.
vi.mock('~/env/server', () => ({
  env: { IS_DATAPACKET: false, LOGGING: '', IS_BUILD: true },
}));

vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: any) => `${file.id}.safetensors`,
}));
vi.mock('~/server/utils/url-helpers', () => ({ getBaseUrl: () => 'https://civitai.com' }));
vi.mock('~/server/services/training-data-restricted.service', () => ({
  trainingDataListing:
    async (
      _db: unknown,
      _versions: unknown,
      { redCapable, viewerManages }: { redCapable: boolean; viewerManages?: boolean }
    ) =>
    (file: { type: string }) =>
      file.type !== 'Training Data' || redCapable || !!viewerManages,
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isRedCapableHost: (host?: string | null) => host === 'civitai.red',
}));

const FILE = {
  id: 11,
  modelVersionId: 4242,
  type: 'Model',
  visibility: 'Public',
  sizeKB: 1111,
  hashes: [{ type: 'SHA256', hash: 'aaaa1111' }],
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
};

function modelItem(id: number, mode: string | null, images: unknown[]) {
  return {
    id,
    name: `Model ${id}`,
    mode,
    tagsOnModels: [],
    user: { username: 'creator', image: null, profilePicture: null },
    modelVersions: [{ id: 4242, name: 'v1', status: 'Published', files: [FILE], images }],
  };
}

function fakeRes() {
  const res: any = {
    headers: {},
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
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
  return res as NextApiResponse & { statusCode?: number; body?: any };
}

async function invoke(id: string, host = 'civitai.com') {
  const mod = await import('~/pages/api/v1/models/[id]');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method: 'GET',
    query: { id },
    headers: { host },
    url: `/api/v1/models/${id}`,
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('GET /api/v1/models/[id] — images is [] when every image is left out, never missing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends images: [] for a version whose images were all left out', async () => {
    mockGetModelsWithVersions.mockResolvedValue({ items: [modelItem(7, null, [])] });
    const res = await invoke('7');
    expect(res.statusCode).toBe(200);
    expect(res.body.modelVersions[0]).toHaveProperty('images', []);
  });

  it('sends images: [] for a taken-down model, whose images are withheld', async () => {
    const image = { id: 1, url: 'u', type: 'image', nsfwLevel: 1 };
    mockGetModelsWithVersions.mockResolvedValue({ items: [modelItem(7, 'TakenDown', [image])] });
    const res = await invoke('7');
    expect(res.statusCode).toBe(200);
    expect(res.body.modelVersions[0]).toHaveProperty('images', []);
  });
});
