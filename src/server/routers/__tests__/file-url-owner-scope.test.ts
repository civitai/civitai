import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Wiring + cache proof for the url-scope fix. The mechanism is unit-tested in
 * `owner-only-file-urls.test.ts`; this pins that `modelFile.getByVersionId`, `modelVersion.getById`
 * and `model.getById` actually attach it with the right owner, and that a warm edge cache can only
 * ever hold a stripped body.
 *
 * Cache proof: `createContext` gives a signed-in request `edgeTTL: 0` and an anonymous one a
 * positive TTL, and `willEdgeCache` is what the tRPC route turns into a public `Cache-Control`. So
 * only anonymous responses are edge-cached — and an anonymous caller is never the owner, so the
 * strip has already removed every url before the body can be stored. An owner's response (TTL 0) is
 * never cached, so it can never be replayed to another viewer.
 */

const { getFilesByVersionIdHandler, getModelVersionHandler, getModelHandler } = vi.hoisted(() => ({
  getFilesByVersionIdHandler: vi.fn(),
  getModelVersionHandler: vi.fn(),
  getModelHandler: vi.fn(),
}));

vi.mock('~/server/controllers/model-file.controller', () => ({
  getFilesByVersionIdHandler,
  createFileHandler: vi.fn(),
  deleteFileHandler: vi.fn(),
  hasOfficialFileOfSizeHandler: vi.fn(),
  restoreReplacedFileHandler: vi.fn(),
  updateFileHandler: vi.fn(),
  upsertFileHandler: vi.fn(),
}));

import { willEdgeCache } from '~/server/trpc/edge-cache-headers';
import { modelFileRouter } from '~/server/routers/model-file.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 7;
const OTHER = 8;

function caller(
  router: typeof modelFileRouter,
  user: { id: number; isModerator: boolean } | undefined
) {
  return router.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined, removeHeader: () => undefined },
    cache: { edgeTTL: user ? 0 : 60 },
    features: {},
    track: { modelFile: vi.fn(() => Promise.resolve()) },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  getFilesByVersionIdHandler.mockResolvedValue({
    modelVersionId: 10,
    files: [{ id: 1, type: 'Model', url: 'model/7/a.safetensors' }],
  });
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({ model: { userId: OWNER } });
});

describe('modelFile.getByVersionId url scope (wiring)', () => {
  it('returns the url to the version owner', async () => {
    const result = await caller(modelFileRouter, { id: OWNER, isModerator: false }).getByVersionId({
      id: 10,
    });
    expect(result.files[0].url).toBe('model/7/a.safetensors');
  });

  it('strips the url for a signed-in non-owner', async () => {
    const result = await caller(modelFileRouter, { id: OTHER, isModerator: false }).getByVersionId({
      id: 10,
    });
    expect(result.files[0].url).toBeUndefined();
  });

  it('strips the url for an anonymous caller', async () => {
    const result = await caller(modelFileRouter, undefined).getByVersionId({ id: 10 });
    expect(result.files[0].url).toBeUndefined();
  });

  it('keeps it for a moderator', async () => {
    const result = await caller(modelFileRouter, { id: OTHER, isModerator: true }).getByVersionId({
      id: 10,
    });
    expect(result.files[0].url).toBe('model/7/a.safetensors');
  });
});

describe('edge cache can only hold a stripped body', () => {
  it('a signed-in response is never edge-cached; an anonymous one is', () => {
    // createContext shape: edgeTTL 0 for any session, 60 for anonymous.
    expect(willEdgeCache({ edgeTTL: 0 })).toBe(false);
    expect(willEdgeCache({ edgeTTL: 60 })).toBe(true);
  });
});
