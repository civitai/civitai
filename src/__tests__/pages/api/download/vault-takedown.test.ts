import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/** A vault copy of a taken-down model's file, images or details is served to moderators only. */

const { mockGetVaultWithStorage, mockHasEntityAccess, mockResolveDownloadUrl } = vi.hoisted(() => ({
  mockGetVaultWithStorage: vi.fn(),
  mockHasEntityAccess: vi.fn(),
  mockResolveDownloadUrl: vi.fn(),
}));

vi.mock('~/server/services/vault.service', () => ({
  getVaultWithStorage: mockGetVaultWithStorage,
}));

vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: mockHasEntityAccess }));

vi.mock('~/utils/delivery-worker', () => ({ resolveDownloadUrl: mockResolveDownloadUrl }));

const { mockGetGetUrlByKey } = vi.hoisted(() => ({ mockGetGetUrlByKey: vi.fn() }));
vi.mock('~/utils/s3-utils', () => ({ getGetUrlByKey: mockGetGetUrlByKey }));

const TEST_USER = { id: 4242, isModerator: false };

vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: typeof TEST_USER) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, TEST_USER),
}));

import handler from '~/pages/api/download/vault/[vaultItemId]';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
const mockVaultItemFindUnique = dbMock.dbRead.vaultItem.findUnique;
const mockModelVersionFindUnique = dbMock.dbRead.modelVersion.findUnique;

function run(fileId?: string, type: 'model' | 'images' | 'details' = 'model') {
  const req = {
    method: 'GET',
    query: { vaultItemId: '31', type, ...(fileId ? { fileId } : {}) },
    headers: {},
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as NextApiResponse;
  return { promise: handler(req, res), res };
}

// The model's state comes back only when the read includes it, as in prod.
const givenModel = (model: { status: string; mode: string | null }) =>
  mockModelVersionFindUnique.mockImplementation((async (args: {
    include?: { model?: unknown };
  }) => ({
    id: 9,
    usageControl: 'Download',
    ...(args.include?.model ? { model } : {}),
  })) as never);

describe('/api/download/vault/[vaultItemId] — a taken-down model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TEST_USER.isModerator = false;
    setEnv({ S3_VAULT_BUCKET: 'vault-bucket' });
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
    dbMock.dbRead.modelFile.findUnique.mockResolvedValue(null);
    mockGetVaultWithStorage.mockResolvedValue({
      updatedAt: new Date(),
      storageKb: 1_000_000,
      usedStorageKb: 1,
    });
    mockVaultItemFindUnique.mockResolvedValue({
      id: 31,
      modelVersionId: 9,
      modelName: 'model',
      versionName: 'v1',
      files: [{ id: 1, url: 'files/model.safetensors', displayName: 'model.safetensors' }],
    });
    mockHasEntityAccess.mockResolvedValue([{ hasAccess: true, permissions: 0xffff }]);
    mockResolveDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/model.safetensors' });
    mockGetGetUrlByKey.mockImplementation(async (key: string) => ({
      url: `https://example.invalid/${key}`,
    }));
  });

  it("refuses the vault's owner with the same 404 as a file it does not hold", async () => {
    givenModel({ status: 'Published', mode: 'TakenDown' });
    const missing = run('999');
    await missing.promise;
    const refused = run();
    await refused.promise;

    expect(refused.res.status).toHaveBeenCalledWith(404);
    expect(vi.mocked(refused.res.json).mock.calls).toEqual(vi.mocked(missing.res.json).mock.calls);
    expect(vi.mocked(refused.res.json).mock.calls).toEqual([[{ error: 'File not found' }]]);
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('still serves a moderator', async () => {
    TEST_USER.isModerator = true;
    givenModel({ status: 'Published', mode: 'TakenDown' });
    const { promise, res } = run();
    await promise;

    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });

  it.each([
    ['a published model', { status: 'Published', mode: null }],
    ['a deleted model', { status: 'Deleted', mode: null }],
  ])('keeps serving %s from the vault', async (_state, model) => {
    givenModel(model);
    const { promise, res } = run();
    await promise;

    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });

  describe.each([
    ['images', 'https://example.invalid/9/4242/images.zip'],
    ['details', 'https://example.invalid/9/4242/details.pdf'],
  ] as const)('the %s download', (type, signedUrl) => {
    it("refuses the vault's owner with the model file's 404", async () => {
      givenModel({ status: 'Published', mode: 'TakenDown' });
      const { promise, res } = run(undefined, type);
      await promise;

      expect(res.status).toHaveBeenCalledWith(404);
      expect(vi.mocked(res.json).mock.calls).toEqual([[{ error: 'File not found' }]]);
      expect(res.redirect).not.toHaveBeenCalled();
      expect(mockGetGetUrlByKey).not.toHaveBeenCalled();
    });

    it('still serves a moderator', async () => {
      TEST_USER.isModerator = true;
      givenModel({ status: 'Published', mode: 'TakenDown' });
      const { promise, res } = run(undefined, type);
      await promise;

      expect(res.redirect).toHaveBeenCalledWith(signedUrl);
    });

    it.each([
      ['a published model', { status: 'Published', mode: null }],
      ['a deleted model', { status: 'Deleted', mode: null }],
    ])('keeps serving %s from the vault', async (_state, model) => {
      givenModel(model);
      const { promise, res } = run(undefined, type);
      await promise;

      expect(res.redirect).toHaveBeenCalledWith(signedUrl);
    });

    it('keeps serving a version that no longer exists on the site', async () => {
      mockModelVersionFindUnique.mockResolvedValue(null);
      const { promise, res } = run(undefined, type);
      await promise;

      expect(res.redirect).toHaveBeenCalledWith(signedUrl);
    });
  });
});
