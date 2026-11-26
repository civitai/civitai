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
import type { RunnerMintReads } from '@civitai/db-queries/recipe-runner';
import type { RunnerMintDeps } from '~/server/services/blocks/runner-mint-handler';

/**
 * A client-credentials token is single-purpose: it is only accepted on the catalog endpoints.
 * Everything else that authenticates a bearer credential (tRPC context, the REST session
 * helper, moderator endpoints) resolves it to no session, while an ordinary OAuth access token
 * with the same base scope still works outside moderator surfaces. The real
 * `getSessionFromBearerToken` runs throughout; only the key row, the user lookup and side-effect
 * modules are stubbed.
 */

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
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
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');
const { sessionClient } = await import('~/server/auth/session-client');
const { SYSTEM_CLIENT_OWNER_ID, standingRunId } = await import(
  '~/server/services/blocks/runner-mint.service'
);
const { FORCED_SFW_CEILING } = await import('~/server/services/blocks/dev-scoped-mint.service');
const { CONSENT_SPEND_SCOPE } = await import('~/server/services/blocks/scope-grant.service');
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
/** A recipe-runner token: accepted only where the caller passes `allowRunnerMint`. */
const RUNNER_TOKEN = 'civitai_runner';
/** Moderator surfaces take a full-scope personal key, so it is their positive control. */
const PERSONAL_TOKEN = 'civitai_personal';
/** Tokens carrying OTHER opt-in bits above `Full`: they are not client-credentials-only. */
const OPT_IN_TOKENS: Record<string, bigint> = {
  civitai_cli: TokenScope.UserRead | TokenScope.AppBlocksSubmit | TokenScope.LinkConnect,
  civitai_tunnel: TokenScope.UserRead | TokenScope.AppBlocksDevTunnel,
};

function keyRow(token: string) {
  if (token === RUNNER_TOKEN) {
    // As stored: the runner bit lives only in the wide column.
    return {
      id: 504,
      userId: OWNER,
      tokenScope: Number(TokenScope.UserRead),
      tokenScopeWide: TokenScope.UserRead | TokenScope.RunnerMint,
      lastUsedAt: new Date(),
      buzzLimit: null,
      clientId: 'recipe-runner',
      type: 'Access',
    };
  }
  if (token === PERSONAL_TOKEN) {
    return {
      id: 503,
      userId: OWNER,
      tokenScope: TokenScope.Full,
      lastUsedAt: new Date(),
      buzzLimit: null,
      clientId: null,
      type: 'User',
    };
  }
  return {
    id: token === CATALOG_TOKEN ? 501 : 502,
    userId: OWNER,
    tokenScope:
      OPT_IN_TOKENS[token] ??
      (token === CATALOG_TOKEN
        ? TokenScope.UserRead | TokenScope.AppStoreCatalogWrite
        : TokenScope.UserRead),
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
    send(payload: unknown) {
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

describe('getSessionFromBearerToken and a runner token', () => {
  it('resolves it to no session by default, and with only the client-credentials opt-in', async () => {
    expect(await getSessionFromBearerToken(RUNNER_TOKEN)).toBeNull();
    expect(
      await getSessionFromBearerToken(RUNNER_TOKEN, { allowClientCredentialsOnly: true })
    ).toBeNull();
  });

  it('resolves it when the caller opts in', async () => {
    const session = await getSessionFromBearerToken(RUNNER_TOKEN, { allowRunnerMint: true });
    expect(session?.user?.id).toBe(OWNER);
  });

  it('getServerAuthSession (the tRPC and REST session) returns no session for it', async () => {
    expect(await getServerAuthSession({ req: req(RUNNER_TOKEN), res: res() })).toBeNull();
  });

  // A merge condition from auth: the orchestrator's spend check on /me is no guarantee, so a runner
  // token must never read a user (or a Buzz limit) here.
  it('/api/v1/me answers 401 for it and runs no handler; an ordinary token gets 200', async () => {
    const { default: me } = await import('~/pages/api/v1/me');
    const refused = res();
    await me(req(RUNNER_TOKEN) as never, refused);
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toHaveProperty('id');
    // Control: the same route with an ordinary OAuth token runs the handler.
    const ordinary = res();
    await me(req(ORDINARY_TOKEN) as never, ordinary);
    expect(ordinary.statusCode).toBe(200);
    expect(ordinary.body).toMatchObject({ id: OWNER });
  });

  it('AuthedEndpoint answers 401 for it and never runs the handler', async () => {
    const handler = vi.fn(async () => undefined);
    const r = res();
    await AuthedEndpoint(handler)(req(RUNNER_TOKEN) as never, r);
    expect(r.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the runner mint path of /api/v1/block-tokens', () => {
  // The fixed-window limits fail closed; here they admit, so the refusal under test decides.
  beforeEach(() => {
    redisMock.redis.incrBy.mockResolvedValue(1);
  });
  const DAY = 86_400_000;
  const RUNNER_CLIENT = 'recipe-runner';
  const authorization = () => ({
    id: 'rra_x',
    userId: OWNER,
    runnerClientId: RUNNER_CLIENT,
    kind: 'standing',
    runId: null,
    maxAmountPerRun: 50,
    maxRunsPerPeriod: 3,
    period: 'day',
    createdAt: new Date(Date.now() - 5 * DAY),
    expiresAt: new Date(Date.now() + 20 * DAY),
    revokedAt: null,
  });
  /** Every read answers the passing case for the runner token's client and owner only. */
  const passingReads = (): RunnerMintReads => ({
    client: async (clientId) =>
      clientId === RUNNER_CLIENT
        ? {
            userId: SYSTEM_CLIENT_OWNER_ID,
            isConfidential: true,
            skipConsent: false,
            grants: ['authorization_code', 'refresh_token'],
            accessMode: 'open',
          }
        : null,
    binding: async (clientId) =>
      clientId === RUNNER_CLIENT ? { appBlockId: 'apb_runner', status: 'active' } : null,
    appBlock: async (id) =>
      id === 'apb_runner'
        ? { id, appId: 'app_runner', blockId: 'runner-fixture', status: 'approved' }
        : null,
    consent: async (userId, clientId) =>
      userId === OWNER && clientId === RUNNER_CLIENT
        ? {
            offlineGrantedAt: new Date(Date.now() - 6 * DAY),
            offlineBuzzLimit: 200,
            offlineBuzzPeriod: 'week',
          }
        : null,
    authorization: async (id) => (id === 'rra_x' ? authorization() : null),
    hasLiveAttempt: async () => false,
    capUsed: async () => 0,
    runsSince: async () => 0,
  });
  const passingDeps = (over: Partial<RunnerMintDeps> = {}): RunnerMintDeps => ({
    appBlocksOn: () => true,
    offlineGrantOn: async () => true,
    reads: async () => passingReads(),
    // Not the forced ceiling, so a swapped claim shows.
    viewerLevel: async (userId) => (userId === OWNER ? 1 : 0),
    ...over,
  });
  const mint = async (token: string | null, body: unknown, deps = passingDeps()) => {
    const { handleRunnerMint } = await import('~/server/services/blocks/runner-mint-handler');
    const r = res();
    const request = {
      ...req(token ?? ''),
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    };
    await handleRunnerMint(request as never, r, deps);
    return r as typeof r & { body: { reason?: string; token?: string; runId?: string } };
  };
  const body = { runner: { authorizationId: 'rra_x', runKey: 'trigger-1', amount: 10 } };
  const claimsOf = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  const sessionUser = (over: Record<string, unknown>) =>
    vi.mocked(sessionClient.getSessionUserById).mockResolvedValueOnce({
      id: OWNER,
      username: 'owner',
      isModerator: true,
      bannedAt: null,
      permissions: [],
      ...over,
    } as never);

  it('mints a 180-second runner token for the run, carrying the requested budget', async () => {
    const r = await mint(RUNNER_TOKEN, body);
    expect(r.statusCode).toBe(200);
    const claims = claimsOf(r.body.token!);
    expect(claims.runId).toBe(standingRunId('rra_x', 'trigger-1'));
    expect(r.body.runId).toBe(claims.runId);
    expect(claims.buzzBudget).toBe(10);
    expect(claims.scopes).toEqual([CONSENT_SPEND_SCOPE]);
    expect(claims.maxBrowsingLevel).toBe(FORCED_SFW_CEILING);
    expect(claims.viewerBrowsingLevel).toBe(1);
    expect(FORCED_SFW_CEILING).not.toBe(1);
  });

  it('refuses a runner client over its shared per-client limit', async () => {
    // Only the per-client counter (`block-token-runner:<client>`) is over 600.
    redisMock.redis.incrBy.mockImplementation(async (key: string) =>
      /block-token-runner:[^:]+$/.test(key) ? 601 : 1
    );
    const r = await mint(RUNNER_TOKEN, body);
    expect(r.statusCode).toBe(429);
    expect(r.body).toMatchObject({ rateLimit: { id: 'apps.block-token-runner-mint' } });
  });

  it('refuses a caller over the per-user limit, with Retry-After', async () => {
    // One over the handler's PER_USER_LIMIT (10/min); the per-IP and per-client limits admit it.
    redisMock.redis.incrBy.mockResolvedValue(11);
    const r = await mint(RUNNER_TOKEN, body);
    expect(r.statusCode).toBe(429);
    expect(r.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(r.body).toMatchObject({ rateLimit: { id: 'apps.block-token-runner-mint' } });
  });

  it('refuses an address over the per-IP limit before reading the credential', async () => {
    // One over the handler's PER_IP_LIMIT (1200/min).
    redisMock.redis.incrBy.mockResolvedValue(1201);
    const r = await mint(RUNNER_TOKEN, body);
    expect(r.statusCode).toBe(429);
    expect(r.body).toMatchObject({ rateLimit: { id: 'apps.block-token-runner-mint-ip' } });
    expect(dbMock.dbWrite.apiKey.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a muted user, and a system account', async () => {
    sessionUser({ muted: true });
    expect((await mint(RUNNER_TOKEN, body)).body.reason).toBe('user_restricted');
    // A banned user is refused one step earlier: the bearer lookup resolves them to no one.
    sessionUser({ bannedAt: new Date() });
    const banned = await mint(RUNNER_TOKEN, body);
    expect([banned.statusCode, banned.body.token]).toEqual([401, undefined]);
    // Its own gate passes a system account with write keys allowed; the mint still refuses it.
    sessionUser({ meta: { systemAccount: true, allowModeratorWriteKeys: true } });
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      meta: { allowModeratorWriteKeys: true },
      isModerator: false,
      roles: [],
    });
    expect((await mint(RUNNER_TOKEN, body)).body.reason).toBe('system_account');
  });

  it('refuses while the apps flag or the offline-grant flag is off', async () => {
    const apps = await mint(RUNNER_TOKEN, body, passingDeps({ appBlocksOn: () => false }));
    expect([apps.statusCode, apps.body.reason]).toEqual([403, 'apps_flag']);
    const offline = await mint(
      RUNNER_TOKEN,
      body,
      passingDeps({ offlineGrantOn: async () => false })
    );
    expect([offline.statusCode, offline.body.reason]).toEqual([403, 'offline_flag']);
  });

  it('answers 503 when its reads fail, and 403 with the reason when the decision refuses', async () => {
    const down = await mint(
      RUNNER_TOKEN,
      body,
      passingDeps({
        reads: async () => ({ ...passingReads(), consent: () => Promise.reject(new Error('db')) }),
      })
    );
    expect([down.statusCode, down.body.reason]).toEqual([503, 'unavailable']);
    const refused = await mint(RUNNER_TOKEN, { runner: { ...body.runner, amount: 51 } });
    expect([refused.statusCode, refused.body.reason]).toEqual([403, 'amount']);
    expect(refused.body.token).toBeUndefined();
  });

  it('refuses a request with no bearer (a session cookie never reaches it)', async () => {
    expect((await mint(null, body)).statusCode).toBe(401);
  });

  it('refuses an ordinary OAuth token, and a client-credentials one', async () => {
    expect((await mint(ORDINARY_TOKEN, body)).statusCode).toBe(401);
    expect((await mint(CATALOG_TOKEN, body)).statusCode).toBe(401);
  });

  it('refuses a malformed runner body before reading the credential', async () => {
    const bad = { runner: { authorizationId: 'rra_x', runKey: 'has spaces', amount: 10 } };
    expect((await mint(RUNNER_TOKEN, bad)).statusCode).toBe(400);
    expect((await mint(RUNNER_TOKEN, { runner: { ...body.runner, amount: 0 } })).statusCode).toBe(
      400
    );
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
    await expect((await caller(PERSONAL_TOKEN)).searchForModerator({})).resolves.toBeDefined();
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
    await endpoint(req(PERSONAL_TOKEN), ok);
    expect(ok.statusCode).toBe(200);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('tokens with other opt-in scopes above Full', () => {
  it.each(Object.entries(OPT_IN_TOKENS))(
    '%s still resolves on getServerAuthSession and passes AuthedEndpoint',
    async (token, scope) => {
      const session = await getServerAuthSession({ req: req(token), res: res() });
      expect(session?.user?.id).toBe(OWNER);
      // The session object carries the scope as a JSON number (it can reach page props).
      expect((session as { tokenScope?: number } | null)?.tokenScope).toBe(Number(scope));

      const handler = vi.fn(async () => undefined);
      const r = res();
      await AuthedEndpoint(handler)(req(token) as never, r);
      expect(r.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    }
  );
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
