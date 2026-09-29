import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

const { isFliptMock, isRevokedMock, sessionMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
  isRevokedMock: vi.fn(async () => false),
  sessionMock: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: isRevokedMock },
}));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: sessionMock }));
const { tunnelMock } = vi.hoisted(() => ({ tunnelMock: vi.fn(async () => null as unknown) }));
vi.mock('~/server/services/blocks/dev-tunnel.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getActiveDevTunnel: (...a: unknown[]) => tunnelMock(...a),
}));

import { dbMock } from '~/__tests__/mocks';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { withBlockScope, type BlockScopedNextApiRequest } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const USER_ID = 42;
const CLIENT_ID = 'app_hub';
const APP_BLOCK_ID = 'apb_hub';
const BLOCK_ID = 'blk_hub';
const SCOPE = 'user:read:self';

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
    removeHeader() {
      return undefined;
    },
    writeHead() {
      return this;
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

async function drive(bearer: string) {
  let seen: BlockScopedNextApiRequest['blockClaims'];
  const handler = vi.fn(async (req: NextApiRequest, res: NextApiResponse) => {
    seen = (req as BlockScopedNextApiRequest).blockClaims;
    res.status(200).json({ via: 'handler' });
  });
  const route = withBlockScope(handler as never, { endpoint: 'me', requiredScope: SCOPE });
  const req = {
    method: 'GET',
    headers: { authorization: `Bearer ${bearer}` },
    query: {},
    url: '/api/v1/blocks/me',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
  const res = makeRes();
  await route(req, res);
  return { handler, res, claims: seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ APP_BLOCK_OAUTH_TOKENS_ENABLED: true });
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
    id: APP_BLOCK_ID,
    blockId: BLOCK_ID,
    manifest: { scopes: [SCOPE, 'apps:storage:read', 'buzz:read:self'] },
    approvedScopes: [SCOPE, 'apps:storage:read', 'buzz:read:self'],
  });
  dbMock.dbRead.appUserScopeGrant.findUnique.mockResolvedValue({
    grantedScopes: [SCOPE],
    revokedAt: null,
  });
});

describe('withBlockScope with a hub-issued OAuth token', () => {
  it('builds block claims from the viewer grant for a client that owns a block', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 99,
      subject: { type: 'oauth', id: CLIENT_ID },
    });

    const { res, claims } = await drive('civ_oauth_access_token');

    expect(res.statusCode).toBe(200);
    expect(claims).toMatchObject({
      sub: `user:${USER_ID}`,
      appId: CLIENT_ID,
      appBlockId: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      blockInstanceId: `page_${APP_BLOCK_ID}`,
    });
    // consent-exempt scopes ride along; the ungranted buzz scope is withheld
    expect([...(claims?.scopes ?? [])].sort()).toEqual(['apps:storage:read', SCOPE]);
    expect(dbMock.dbRead.appBlock.findFirst.mock.calls[0][0].where).toEqual({
      appId: CLIENT_ID,
      status: 'approved',
    });
  });

  it('does not even look at an opaque bearer while the flag is off', async () => {
    setEnv({ APP_BLOCK_OAUTH_TOKENS_ENABLED: false });

    const { handler, claims } = await drive('civ_oauth_token');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(claims).toBeUndefined();
    expect(sessionMock).not.toHaveBeenCalled();
  });

  it('never elevates a personal API key to block claims', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 5,
      subject: { type: 'apiKey', id: 5 },
    });

    const { handler, claims } = await drive('civ_personal_key');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(claims).toBeUndefined();
    expect(dbMock.dbRead.appBlock.findFirst).not.toHaveBeenCalled();
  });

  it('binds the borrowed dev client of a never-submitted app to its author’s live tunnel', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: `appdev-${USER_ID}-my-app` },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
    tunnelMock.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted', SCOPE, 'collections:read:self'],
    });
    dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({ scope: TokenScope.UserRead });

    const { res, claims } = await drive('civ_dev_oauth');

    expect(res.statusCode).toBe(200);
    expect(claims).toMatchObject({
      sub: `user:${USER_ID}`,
      appId: `appdev-${USER_ID}-my-app`,
      appBlockId: 'ephemeral-my-app',
      blockId: 'my-app',
      blockInstanceId: 'page_ephemeral-my-app',
      dev: true,
    });
    expect([...(claims?.scopes ?? [])].sort()).toEqual(['collections:read:self', SCOPE]);
    expect(tunnelMock).toHaveBeenCalledWith(USER_ID, 'my-app');
  });

  it('never binds a dev client to anyone but its author, nor without a live tunnel', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: 'appdev-99-my-app' },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
    const foreign = await drive('civ_dev_oauth');
    expect(foreign.claims).toBeUndefined();
    expect(tunnelMock).not.toHaveBeenCalled();

    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: `appdev-${USER_ID}-my-app` },
    });
    tunnelMock.mockResolvedValue(null);
    const closed = await drive('civ_dev_oauth');
    expect(closed.claims).toBeUndefined();
  });

  it('binds an owned, not-yet-approved app’s real client to its author’s tunnel with real ids', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      manifest: { page: { buzzBudgetPerGen: 75 } },
      approvedScopes: ['ai:write:budgeted', SCOPE],
    });
    tunnelMock.mockResolvedValue({ grantedScopes: [] });
    dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({
      scope: TokenScope.UserRead | TokenScope.AIServicesWrite,
    });

    const { claims } = await drive('civ_dev_oauth');

    expect(claims).toMatchObject({
      appId: CLIENT_ID,
      appBlockId: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      blockInstanceId: `page_${APP_BLOCK_ID}`,
      dev: true,
      buzzBudget: 75,
    });
    expect([...(claims?.scopes ?? [])].sort()).toEqual(['ai:write:budgeted', SCOPE]);
    expect(dbMock.dbRead.appBlock.findFirst.mock.calls[1][0].where).toEqual({
      appId: CLIENT_ID,
      app: { userId: USER_ID },
    });
  });

  it('still accepts a block JWT on the unchanged path', async () => {
    const { token } = await BlockTokenService.sign({
      userId: USER_ID,
      blockId: BLOCK_ID,
      appId: CLIENT_ID,
      appBlockId: APP_BLOCK_ID,
      blockInstanceId: 'bki_hub',
      scopes: [SCOPE],
      ctx: {},
    } as Parameters<typeof BlockTokenService.sign>[0]);

    const { res, claims } = await drive(token);

    expect(res.statusCode).toBe(200);
    expect(claims).toMatchObject({ sub: `user:${USER_ID}`, blockInstanceId: 'bki_hub' });
    expect(sessionMock).not.toHaveBeenCalled();
  });
});
