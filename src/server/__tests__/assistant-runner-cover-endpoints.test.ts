import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';

/**
 * App Assistant's server runner reads the user's listing for an app before it offers a cover, as
 * the user its run grant names: `/api/internal/app-assistant/cover/listing`. (The cover itself is
 * made only by the page, on the user's press; the runner has no write here.)
 *
 * The route runs for real down to the listing editor's read, which is replaced by a fake per user
 * (`runnerCoverListingApi`, the tRPC caller): what is pinned here is whose read is called, and that
 * it answers only the user's OWN listing for the app. Also mocked: the App Assistant user gates
 * (`getRunnerDevTunnelUser`, covered in app-assistant.service.test.ts).
 */

const { runnerUserMock, apiForMock } = vi.hoisted(() => ({
  runnerUserMock: vi.fn(),
  apiForMock: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  getRunnerDevTunnelUser: runnerUserMock,
}));
vi.mock('~/server/services/app-assistant/runner-cover-caller', () => ({
  runnerCoverListingApi: (_req: unknown, _res: unknown, user: { id: number }) => apiForMock(user),
}));

const { signRunGrant } = await import('~/server/services/app-assistant/assistant-runner-tokens');
const listingRoute = (await import('~/pages/api/internal/app-assistant/cover/listing')).default;

// TEST-ONLY values: a key pair generated for this run and a placeholder secret.
const SECRET = 'test-only-runner-secret-for-covers';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Pairwise-distinct fixtures: two users, each with one listing, no id or slug shared.
const OWNER = 5101;
const OTHER = 5202;
const OWNED_APP = 'alpha-cover';
const OTHERS_APP = 'beta-cover';
const LISTINGS: Record<
  string,
  { appListingId: string; status: string; editBlockedReason: string | null }
> = {
  [`${OWNER}:${OWNED_APP}`]: {
    appListingId: 'apl_owned',
    status: 'approved',
    editBlockedReason: null,
  },
  [`${OTHER}:${OTHERS_APP}`]: {
    appListingId: 'apl_others',
    status: 'draft',
    editBlockedReason: null,
  },
};

/** The listing editor's procedures as `userId`: their own listings only, as `getMyListingForApp`. */
function fakeApi(userId: number) {
  return {
    getMyListingForApp: vi.fn(async ({ slug }: { slug: string }) => {
      const listing = LISTINGS[`${userId}:${slug}`];
      if (!listing) throw new TRPCError({ code: 'NOT_FOUND', message: 'No listing' });
      return listing;
    }),
  };
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;
const asRunner = { authorization: `Bearer ${SECRET}` };

async function call(
  handler: Handler,
  body: unknown,
  headers: Record<string, string> = asRunner,
  method = 'POST'
) {
  let status = 200;
  let json: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      json = value;
      return res;
    },
    setHeader: () => res,
  } as unknown as NextApiResponse;
  await handler({ method, headers, body, query: {} } as unknown as NextApiRequest, res);
  return { status, json };
}

const grantFor = async (userId: number, use?: 'preview') =>
  (
    await signRunGrant({
      userId,
      conversationId: `c-${userId}`,
      idempotencyKey: `k-${userId}`,
      ...(use ? { use } : {}),
    })
  ).token;

let apis: Map<number, ReturnType<typeof fakeApi>>;

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({
    ASSISTANT_RUNNER_SECRET: SECRET,
    ASSISTANT_RUNNER_SIGNING_KEY: SIGNING_KEY,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
  });
  // A moderator: the read still answers only their OWN listing (`getMyListingForApp`, no override).
  runnerUserMock.mockImplementation(async (userId: number) => ({
    refusal: null,
    user: { id: userId, isModerator: true },
  }));
  apis = new Map();
  apiForMock.mockImplementation((user: { id: number }) => {
    const api = fakeApi(user.id);
    apis.set(user.id, api);
    return api;
  });
});

describe('cover/listing', () => {
  it('answers the grant’s user’s own listing for the app', async () => {
    const { status, json } = await call(listingRoute, {
      grant: await grantFor(OWNER),
      app: OWNED_APP,
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      listing: { listingId: 'apl_owned', blockedReason: null, status: 'approved' },
    });
    expect(runnerUserMock).toHaveBeenCalledWith(OWNER);
    expect(apis.get(OWNER)!.getMyListingForApp).toHaveBeenCalledWith({ slug: OWNED_APP });
  });

  it('answers none for an app with no listing, or someone else’s', async () => {
    for (const app of ['gamma-cover', OTHERS_APP]) {
      const { status, json } = await call(listingRoute, { grant: await grantFor(OWNER), app });
      expect(status).toBe(200);
      expect(json).toEqual({ listing: null });
    }
  });

  it('answers unavailable when the listing cannot be read', async () => {
    apiForMock.mockImplementation(() => ({
      ...fakeApi(OWNER),
      getMyListingForApp: vi.fn(async () => {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'db detail' });
      }),
    }));
    const { status, json } = await call(listingRoute, {
      grant: await grantFor(OWNER),
      app: OWNED_APP,
    });
    expect(status).toBe(503);
    expect(json).toEqual({
      error: 'Your app’s store listing could not be read right now.',
      code: 'unavailable',
    });
  });

  it('refuses a preview grant, a refused user, and a caller without the runner’s secret', async () => {
    const preview = await call(listingRoute, {
      grant: await grantFor(OWNER, 'preview'),
      app: OWNED_APP,
    });
    expect(preview).toMatchObject({ status: 403, json: { code: 'refused' } });

    runnerUserMock.mockResolvedValueOnce({
      refusal: {
        status: 403,
        error: 'You do not have access to Apps authoring',
        code: 'FORBIDDEN',
      },
    });
    const refused = await call(listingRoute, { grant: await grantFor(OWNER), app: OWNED_APP });
    expect(refused).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });

    const stranger = await call(
      listingRoute,
      { grant: await grantFor(OWNER), app: OWNED_APP },
      { authorization: 'Bearer not-the-secret' }
    );
    expect(stranger.status).toBe(401);
    expect(apiForMock).not.toHaveBeenCalled();
  });

  it('refuses a grant civitai did not sign, or one that has expired, before reading anything', async () => {
    const forged = await call(listingRoute, { grant: 'test-only-not-a-grant', app: OWNED_APP });
    expect(forged).toEqual({
      status: 401,
      json: { error: 'Not a current run grant', code: 'invalid_grant' },
    });

    const grant = await grantFor(OWNER);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Past the grant's 7800 s life by a day, whatever skew the verifier allows.
      vi.setSystemTime(Date.now() + (7800 + 86_400) * 1000);
      const expired = await call(listingRoute, { grant, app: OWNED_APP });
      expect(expired).toEqual({
        status: 401,
        json: { error: 'Not a current run grant', code: 'invalid_grant' },
      });
    } finally {
      vi.useRealTimers();
    }
    expect(runnerUserMock).not.toHaveBeenCalled();
    expect(apiForMock).not.toHaveBeenCalled();
  });

  it('refuses a body with no app, or an app that is not a string', async () => {
    const grant = await grantFor(OWNER);
    for (const body of [{ grant }, { grant, app: 4242 }, { grant, app: '' }]) {
      const { status, json } = await call(listingRoute, body);
      expect(status).toBe(400);
      expect(json).toEqual({ error: 'Expected { grant, app }' });
    }
    expect(runnerUserMock).not.toHaveBeenCalled();
    expect(apiForMock).not.toHaveBeenCalled();
  });

  it('refuses any method but POST', async () => {
    const grant = await grantFor(OWNER);
    for (const method of ['GET', 'PUT']) {
      const { status, json } = await call(
        listingRoute,
        { grant, app: OWNED_APP },
        asRunner,
        method
      );
      expect(status).toBe(405);
      expect(json).toEqual({ error: 'Method not allowed' });
    }
    expect(runnerUserMock).not.toHaveBeenCalled();
    expect(apiForMock).not.toHaveBeenCalled();
  });
});
