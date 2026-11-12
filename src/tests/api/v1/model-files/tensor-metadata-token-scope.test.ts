import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';

// Moderator rights through a bearer credential on the tensor-metadata route follow the download
// routes' rule: a cookie session or a full-scope personal key.

const h = vi.hoisted(() => ({
  user: undefined as undefined | Record<string, unknown>,
  context: undefined as undefined | Record<string, unknown>,
  getFileForModelVersion: vi.fn(),
  variant: null as string | null,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFliptVariant: vi.fn(async (flag: string) =>
    flag === 'download-scope-gate' ? h.variant : null
  ),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (handler: (req: unknown, res: unknown, user: unknown) => unknown) =>
    (req: NextApiRequest & { context?: Record<string, unknown> }, res: unknown) => {
      if (h.context) req.context = { ...h.context };
      return handler(req, res, h.user);
    },
}));
vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: (...args: unknown[]) => h.getFileForModelVersion(...args),
}));
vi.mock('~/server/services/tensor-metadata.service', () => ({
  getFullTensorAnalysisCached: vi.fn(async () => ({
    format: 'SafeTensor',
    tensorCount: 0,
    totalTensorBytes: 0,
    dtypes: [],
    largestTensor: null,
    vramEstimate: null,
    tensors: [],
  })),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void;
beforeAll(async () => {
  handler = (await import('~/pages/api/v1/model-files/[id]/tensor-metadata')).default as never;
}, 120000);

async function call(user: Record<string, unknown>, context?: Record<string, unknown>) {
  h.user = user;
  h.context = context;
  const res = {
    statusCode: 0,
    setHeader: () => res,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json: () => res,
  };
  await handler(
    {
      method: 'GET',
      query: { id: '7' },
      headers: context ? { authorization: 'Bearer k' } : {},
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res.statusCode;
}

const key = (tokenScope: number) => ({
  apiKeyId: 5,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 5 },
  tokenScope,
});
const moderator = { id: 20, isModerator: true };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.modelFile.findUnique.mockResolvedValue({
    id: 7,
    modelVersionId: 70,
    name: 'draft.safetensors',
    type: 'Model',
    sizeKB: 1,
    metadata: { format: 'SafeTensor' },
    modelVersion: { model: { type: 'Checkpoint' } },
  } as never);
  // A file only moderators may reach.
  h.getFileForModelVersion.mockImplementation(
    async ({ user }: { user?: { isModerator?: boolean } }) =>
      user?.isModerator
        ? { status: 'success', url: 'https://delivery.example/f' }
        : { status: 'no-access' }
  );
});

describe('/api/v1/model-files/[id]/tensor-metadata, a moderator', () => {
  it('with a Read Only key is not given what only a moderator may read', async () => {
    expect(await call(moderator, key(TokenScopePresets.ReadOnly))).toBe(403);
  });

  it('with a full-scope personal key, or a cookie session, is', async () => {
    expect(await call(moderator, key(TokenScope.Full))).toBe(200);
    expect(await call(moderator)).toBe(200);
  });
});

describe('/api/v1/model-files/[id]/tensor-metadata, the system account', () => {
  const system = { id: -1, isModerator: true };

  it.each([null, 'log', 'enforce'])(
    'keeps moderator reads with ModelsRead (flag %s)',
    async (v) => {
      h.variant = v;
      expect(await call(system, key(TokenScope.ModelsRead))).toBe(200);
    }
  );

  it.each([null, 'log', 'enforce'])(
    'loses them with a key without ModelsRead (flag %s)',
    async (v) => {
      h.variant = v;
      expect(await call(system, key(TokenScope.UserRead))).toBe(403);
    }
  );
});
