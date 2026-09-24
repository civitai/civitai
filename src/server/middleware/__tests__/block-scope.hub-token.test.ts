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

import { dbMock } from '~/__tests__/mocks';
import { withBlockScope, type BlockScopedNextApiRequest } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';

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
