import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';

// The vault, attachment and training-epoch download routes and the scope of the bearer credential
// that reaches them. The session layer is faked to record `req.context` the way
// `getServerAuthSession` does.

const OWNER_ID = 10;
const MODERATOR_ID = 20;
const EPOCH_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/MODEL3.safetensors?sig=abc';

const h = vi.hoisted(() => ({
  caller: null as null | { user: { id: number; isModerator?: boolean }; context?: object },
  variant: null as string | null,
  getVaultWithStorage: vi.fn(),
  hasEntityAccess: vi.fn(),
  resolveDownloadUrl: vi.fn(),
  getDownloadUrl: vi.fn(),
  getFileWithPermission: vi.fn(),
}));

type Req = NextApiRequest & { context?: Record<string, unknown> };
/** Records the caller's credential on `req.context`, as `getServerAuthSession` does. */
function resolveSession(req: Req) {
  req.context = { ...(req.context ?? {}), ...(h.caller?.context ?? {}) };
  return h.caller ? { user: { username: 'u', bannedAt: null, ...h.caller.user } } : null;
}

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: async ({ req }: { req: Req }) => resolveSession(req),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
  AuthedEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    async (req: Req, res: NextApiResponse) => {
      const session = resolveSession(req);
      if (!session) return res.status(401).json({ error: 'Unauthorized' });
      return handler(req, res, session.user);
    },
  handleEndpointError: (res: NextApiResponse, error: unknown) =>
    res.status(500).json({ error: String(error) }),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: vi.fn(async (flag: string) =>
    flag === 'download-scope-gate' ? h.variant : null
  ),
}));
vi.mock('~/server/services/vault.service', () => ({ getVaultWithStorage: h.getVaultWithStorage }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: h.hasEntityAccess }));
vi.mock('~/utils/delivery-worker', () => ({
  resolveDownloadUrl: h.resolveDownloadUrl,
  getDownloadUrl: h.getDownloadUrl,
}));
vi.mock('~/utils/s3-utils', () => ({ getGetUrlByKey: vi.fn() }));
vi.mock('~/server/services/file.service', () => ({
  getFileWithPermission: h.getFileWithPermission,
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    file = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorToken>()),
  getOrchestratorToken: async () => 'token',
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import vaultRoute from '~/pages/api/download/vault/[vaultItemId]';
import attachmentRoute from '~/pages/api/download/attachments/[fileId]';
import trainingRoute from '~/pages/api/download/training/[modelVersionId]';

const personalKey = (tokenScope: number | undefined) => ({
  apiKeyId: 5,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 5 },
  ...(tokenScope === undefined ? {} : { tokenScope }),
});
const oauthToken = (tokenScope: number) => ({
  apiKeyId: 6,
  apiKeyType: 'Access',
  subject: { type: 'oauth', id: 'client-abc' },
  tokenScope,
});
const SCOPE_REFUSAL = { error: 'Your API key does not have the required scope for this action' };

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  query: Record<string, string>,
  caller: typeof h.caller
) {
  h.caller = caller;
  const req = {
    method: 'GET',
    url: '/api/download',
    query,
    headers: caller?.context ? { authorization: 'Bearer the-key' } : {},
    socket: { remoteAddress: '203.0.113.7' },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as NextApiResponse;
  await route(req, res);
  return {
    res,
    status: vi.mocked(res.status).mock.calls.at(-1)?.[0],
    served: vi.mocked(res.redirect).mock.calls.at(-1)?.[0],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.variant = 'enforce';
  setEnv({ S3_VAULT_BUCKET: 'vault-bucket' });
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  dbMock.dbRead.modelFile.findUnique.mockResolvedValue(null);
  dbMock.dbRead.modelFile.findMany.mockResolvedValue([]);
  h.getVaultWithStorage.mockResolvedValue({
    updatedAt: new Date(),
    storageKb: 1_000_000,
    usedStorageKb: 1,
  });
  dbMock.dbRead.vaultItem.findUnique.mockResolvedValue({
    id: 31,
    modelVersionId: 9,
    modelName: 'model',
    versionName: 'v1',
    files: [
      {
        id: 1,
        url: 'files/model.safetensors',
        displayName: 'model.safetensors',
        pickleScanResult: 'Success',
        virusScanResult: 'Success',
        rowDeletedAt: '2026-01-01T00:00:00Z',
      },
    ],
  } as never);
  dbMock.dbRead.modelVersion.findUnique.mockImplementation((async (args: {
    include?: { model?: unknown };
  }) => ({
    id: 9,
    usageControl: 'Download',
    ...(args.include?.model ? { model: { status: 'Published', mode: null } } : {}),
  })) as never);
  h.hasEntityAccess.mockResolvedValue([{ hasAccess: true, permissions: 0xffff }]);
  h.resolveDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/vault.safetensors' });
  // An attachment on an unpublished entity: its owner and moderators get it.
  h.getFileWithPermission.mockImplementation(
    async ({ userId, isModerator }: { userId?: number; isModerator?: boolean }) =>
      userId === OWNER_ID || isModerator
        ? { url: 'files/attachment.zip', name: 'attachment.zip', entityType: 'Model', entityId: 1 }
        : null
  );
  h.getDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/attachment.zip' });
  dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue({
    id: 99,
    trainingStatus: 'InReview',
    trainingDetails: { baseModel: 'sdxl' },
    meta: null,
    model: { id: 7, userId: OWNER_ID, name: 'trained' },
    files: [
      {
        id: 5,
        type: 'Training Data',
        metadata: {
          trainingResults: { version: 2, epochs: [{ epochNumber: 3, modelUrl: EPOCH_URL }] },
        },
      },
    ],
  } as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: null }))
  );
});

describe('vault/[vaultItemId]', () => {
  const run = (caller: typeof h.caller) =>
    call(vaultRoute, { vaultItemId: '31', type: 'model' }, caller);

  it('refuses a key without VaultRead under enforce, and serves one with it', async () => {
    const refused = await run({
      user: { id: OWNER_ID },
      context: personalKey(TokenScope.ModelsRead),
    });
    expect(refused.status).toBe(403);
    expect(refused.res.json).toHaveBeenCalledWith(SCOPE_REFUSAL);
    expect(refused.served).toBeUndefined();

    const allowed = await run({
      user: { id: OWNER_ID },
      context: personalKey(TokenScope.VaultRead),
    });
    expect(allowed.served).toBe('https://example.invalid/vault.safetensors');
  });

  it('refuses a bearer whose recorded credential has no scope', async () => {
    const { status, served } = await run({
      user: { id: OWNER_ID },
      context: personalKey(undefined),
    });
    expect(status).toBe(403);
    expect(served).toBeUndefined();
  });

  it('log: serves a key without VaultRead', async () => {
    h.variant = 'log';
    const { served } = await run({
      user: { id: OWNER_ID },
      context: personalKey(TokenScope.ModelsRead),
    });
    expect(served).toBe('https://example.invalid/vault.safetensors');
  });

  it('serves a full-scope key and a cookie session as before', async () => {
    expect(
      (await run({ user: { id: OWNER_ID }, context: personalKey(TokenScope.Full) })).served
    ).toBe('https://example.invalid/vault.safetensors');
    expect((await run({ user: { id: OWNER_ID } })).served).toBe(
      'https://example.invalid/vault.safetensors'
    );
  });
});

describe('vault/[vaultItemId], a moderator and a taken-down model', () => {
  const run = (caller: typeof h.caller) =>
    call(vaultRoute, { vaultItemId: '31', type: 'model' }, caller);
  const moderator = { id: MODERATOR_ID, isModerator: true };

  beforeEach(() => {
    // Only moderators are served a vault copy of a taken-down model's file.
    dbMock.dbRead.modelVersion.findUnique.mockImplementation((async (args: {
      include?: { model?: unknown };
    }) => ({
      id: 9,
      usageControl: 'Download',
      ...(args.include?.model ? { model: { status: 'Published', mode: 'TakenDown' } } : {}),
    })) as never);
  });

  it.each([null, 'enforce'])(
    'is not served it by a VaultRead-only personal key (flag %s)',
    async (variant) => {
      h.variant = variant;
      const { status, served } = await run({
        user: moderator,
        context: personalKey(TokenScope.VaultRead),
      });
      expect(served).toBeUndefined();
      expect(status).toBe(404);
    }
  );

  it.each([null, 'enforce'])(
    'is served it by a full-scope personal key or a cookie session (flag %s)',
    async (variant) => {
      h.variant = variant;
      expect((await run({ user: moderator, context: personalKey(TokenScope.Full) })).served).toBe(
        'https://example.invalid/vault.safetensors'
      );
      expect((await run({ user: moderator })).served).toBe(
        'https://example.invalid/vault.safetensors'
      );
    }
  );
});

describe('attachments/[fileId]', () => {
  const run = (caller: typeof h.caller) => call(attachmentRoute, { fileId: '8' }, caller);

  it('refuses a key without ModelsRead under enforce, and serves one with it', async () => {
    const refused = await run({
      user: { id: OWNER_ID },
      context: oauthToken(TokenScope.UserRead),
    });
    expect(refused.status).toBe(403);
    expect(refused.served).toBeUndefined();

    const allowed = await run({
      user: { id: OWNER_ID },
      context: personalKey(TokenScope.ModelsRead),
    });
    expect(allowed.served).toBe('https://example.invalid/attachment.zip');
  });

  it("does not serve a moderator's Read Only key what only a moderator may get", async () => {
    h.variant = null;
    const { served } = await run({
      user: { id: MODERATOR_ID, isModerator: true },
      context: personalKey(TokenScopePresets.ReadOnly),
    });
    expect(served).toBeUndefined();
    expect(
      (
        await run({
          user: { id: MODERATOR_ID, isModerator: true },
          context: personalKey(TokenScope.Full),
        })
      ).served
    ).toBe('https://example.invalid/attachment.zip');
  });

  it('serves a full-scope key and a cookie session as before', async () => {
    expect(
      (await run({ user: { id: OWNER_ID }, context: personalKey(TokenScope.Full) })).served
    ).toBe('https://example.invalid/attachment.zip');
    expect((await run({ user: { id: OWNER_ID } })).served).toBe(
      'https://example.invalid/attachment.zip'
    );
  });
});

describe('training/[modelVersionId]', () => {
  const run = (caller: typeof h.caller) =>
    call(trainingRoute, { modelVersionId: '99', epochNumber: '3' }, caller);
  const fetched = () => vi.mocked(fetch).mock.calls.some(([url]) => url === EPOCH_URL);

  it.each([null, 'log', 'enforce'])(
    "refuses the owner's scoped key, ModelsRead included (flag %s)",
    async (variant) => {
      h.variant = variant;
      for (const tokenScope of [TokenScope.ModelsRead, TokenScopePresets.AIServices]) {
        vi.mocked(fetch).mockClear();
        const { status } = await run({ user: { id: OWNER_ID }, context: personalKey(tokenScope) });
        expect(status).toBe(403);
        expect(fetched()).toBe(false);
      }
    }
  );

  it('refuses an OAuth token acting for the owner, even one with every scope', async () => {
    const { status } = await run({
      user: { id: OWNER_ID },
      context: oauthToken(TokenScope.Full),
    });
    expect(status).toBe(403);
    expect(fetched()).toBe(false);
  });

  it("serves the owner's cookie session and full-scope personal key", async () => {
    await run({ user: { id: OWNER_ID } });
    expect(fetched()).toBe(true);
    vi.mocked(fetch).mockClear();
    await run({ user: { id: OWNER_ID }, context: personalKey(TokenScope.Full) });
    expect(fetched()).toBe(true);
  });
});
