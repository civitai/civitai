import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { TRPCError } from '@trpc/server';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * A client-credentials token is single-purpose: it is only accepted on the catalog endpoints.
 * Everything else that authenticates a bearer credential (tRPC context, the REST session
 * helper, moderator endpoints) resolves it to no session, while an ordinary OAuth access token
 * with the same base scope still works. The real `getSessionFromBearerToken` runs throughout;
 * only the key row, the user lookup and side-effect modules are stubbed.
 */

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: {
    getSessionUserById: vi.fn(async (id: number) => ({
      id,
      username: 'owner',
      isModerator: true,
      bannedAt: null,
      permissions: [],
    })),
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    setProvenance = vi.fn();
    retoolAudit = vi.fn();
  },
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn(async () => undefined),
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');
const { getServerAuthSession } = await import('~/server/auth/get-server-auth-session');
const { createContext } = await import('~/server/createContext');
const { oauthClientRouter } = await import('~/server/routers/oauth-client.router');
const { AuthedEndpoint } = await import('~/server/utils/endpoint-helpers');
const { defineModeratorEndpoint } = await import('~/server/utils/moderator-endpoint');
const { resolveCatalogCaller } = await import(
  '~/server/services/blocks/app-sub-listing-catalog-auth'
);

const OWNER = 1;
const CATALOG_TOKEN = 'civitai_catalog';
const ORDINARY_TOKEN = 'civitai_ordinary';

function keyRow(token: string) {
  return {
    id: token === CATALOG_TOKEN ? 501 : 502,
    userId: OWNER,
    tokenScope:
      token === CATALOG_TOKEN
        ? TokenScope.UserRead | TokenScope.AppStoreCatalogWrite
        : TokenScope.UserRead,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: 'game-frame',
    type: 'Access',
  };
}

function req(token: string): NextApiRequest {
  return {
    method: 'GET',
    url: '/api/test',
    headers: { authorization: `Bearer ${token}` },
    query: {},
    cookies: {},
  } as unknown as NextApiRequest;
}

function res() {
  const r = Object.assign(new EventEmitter(), {
    statusCode: 200,
    body: undefined as unknown,
    writableEnded: false,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    end: vi.fn(),
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(payload: unknown) {
      r.body = payload;
      return r;
    },
  });
  return r as typeof r & NextApiResponse;
}

beforeEach(() => {
  resetSharedMocks();
  dbMock.dbWrite.apiKey.findFirst.mockImplementation(
    async ({ where }: { where: { key: string } }) => keyRow(where.key)
  );
  dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue(null);
  dbMock.dbRead.oauthClient.findMany.mockResolvedValue([]);
  dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({
    userId: OWNER,
    grants: ['authorization_code', 'client_credentials'],
  });
  dbMock.dbRead.appListing.findMany.mockResolvedValue([{ id: 'apl_GAMES' }]);
});

describe('getSessionFromBearerToken', () => {
  it('resolves a client-credentials token to no session by default', async () => {
    expect(await getSessionFromBearerToken(CATALOG_TOKEN)).toBeNull();
  });

  it('resolves it when the caller opts in', async () => {
    const session = await getSessionFromBearerToken(CATALOG_TOKEN, {
      allowClientCredentialsOnly: true,
    });
    expect(session?.user?.id).toBe(OWNER);
  });

  it('still resolves an ordinary OAuth access token (positive control)', async () => {
    expect((await getSessionFromBearerToken(ORDINARY_TOKEN))?.user?.id).toBe(OWNER);
  });
});

describe('the REST session helper and AuthedEndpoint', () => {
  it('getServerAuthSession returns no session for a client-credentials token', async () => {
    expect(await getServerAuthSession({ req: req(CATALOG_TOKEN), res: res() })).toBeNull();
    expect((await getServerAuthSession({ req: req(ORDINARY_TOKEN), res: res() }))?.user?.id).toBe(
      OWNER
    );
  });

  it('AuthedEndpoint answers 401 and never runs the handler', async () => {
    const handler = vi.fn(async () => undefined);
    const endpoint = AuthedEndpoint(handler);
    const r = res();
    await endpoint(req(CATALOG_TOKEN) as never, r);
    expect(r.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();

    await endpoint(req(ORDINARY_TOKEN) as never, res());
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('tRPC', () => {
  const caller = async (token: string) =>
    oauthClientRouter.createCaller(await createContext({ req: req(token), res: res() }));

  it('a moderatorProcedure declaring UserRead refuses a client-credentials token', async () => {
    await expect((await caller(CATALOG_TOKEN)).searchForModerator({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect((await caller(ORDINARY_TOKEN)).searchForModerator({})).resolves.toBeDefined();
  });

  it('a protectedProcedure declaring UserRead refuses it too', async () => {
    const err = await (await caller(CATALOG_TOKEN)).getAll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err).toMatchObject({ code: 'UNAUTHORIZED' });
    await expect((await caller(ORDINARY_TOKEN)).getAll()).resolves.toBeDefined();
  });
});

describe('moderator endpoints', () => {
  it('answer 401 for a client-credentials token', async () => {
    redisMock.sysRedis.multi.mockImplementation(() => ({
      set: vi.fn().mockReturnThis(),
      incr: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => ['OK', 1]),
    }));
    const handlerSpy = vi.fn(async () => ({ ok: true }));
    const endpoint = defineModeratorEndpoint('test.single-purpose', {
      method: 'GET',
      summary: 'Probe.',
      input: z.object({}),
      async handler() {
        return handlerSpy();
      },
    } as never);
    const r = res();
    await endpoint(req(CATALOG_TOKEN), r);
    expect(r.statusCode).toBe(401);
    expect(handlerSpy).not.toHaveBeenCalled();

    const ok = res();
    await endpoint(req(ORDINARY_TOKEN), ok);
    expect(ok.statusCode).toBe(200);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('the catalog endpoints', () => {
  it('accept the same client-credentials token', async () => {
    const catalogReq = { ...req(CATALOG_TOKEN), url: '/api/v1/catalog/items' } as NextApiRequest;
    await expect(resolveCatalogCaller(catalogReq)).resolves.toEqual({
      clientId: 'game-frame',
      parentListingId: 'apl_GAMES',
    });
  });
});
