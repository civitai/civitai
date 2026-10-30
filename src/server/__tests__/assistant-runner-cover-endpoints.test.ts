import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';

/**
 * App Assistant's server runner reads the user's listing for an app and attaches the cover it
 * generated, as the user its run grant names: `/api/internal/app-assistant/cover/{listing,attach}`.
 *
 * The routes run for real down to the listing editor's procedures, which are replaced by a fake
 * `CoverListingApi` per user (`runnerCoverListingApi`, the tRPC caller): what is pinned here is
 * whose procedures are called, and that an attach only ever reaches the user's OWN listing for the
 * app. Also mocked: the App Assistant user gates (`getRunnerDevTunnelUser`, covered in
 * app-assistant.service.test.ts).
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
const attachRoute = (await import('~/pages/api/internal/app-assistant/cover/attach')).default;

// TEST-ONLY values: a key pair generated for this run and a placeholder secret.
const SECRET = 'test-only-runner-secret-for-covers';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const IMAGE_URL = 'https://orchestration.example/blobs/cover-endpoint.jpeg';

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
    ingestAssetFromUrl: vi.fn(async () => ({ imageId: 61 })),
    setCover: vi.fn(async () => ({ status: 'ok', scanPending: true })),
  };
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;
const asRunner = { authorization: `Bearer ${SECRET}` };

async function call(handler: Handler, body: unknown, headers: Record<string, string> = asRunner) {
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
  await handler({ method: 'POST', headers, body, query: {} } as unknown as NextApiRequest, res);
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
  // A moderator: `setCover` alone would let them reach any listing, so ownership must come from here.
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
});

describe('cover/attach', () => {
  const attach = async (userId: number, body: Record<string, unknown>) =>
    call(attachRoute, { grant: await grantFor(userId), url: IMAGE_URL, ...body });

  it('ingests the image as a cover and sets it on the user’s own listing', async () => {
    const { status, json } = await attach(OWNER, { app: OWNED_APP, listingId: 'apl_owned' });
    expect(status).toBe(200);
    expect(json).toEqual({ scanPending: true });
    const api = apis.get(OWNER)!;
    expect(api.ingestAssetFromUrl).toHaveBeenCalledWith({ url: IMAGE_URL, kind: 'cover' });
    expect(api.setCover).toHaveBeenCalledWith({ listingId: 'apl_owned', imageId: 61 });
  });

  it('attaches nothing to a listing that is not the user’s own listing for the app', async () => {
    for (const body of [
      // Another user's listing, named outright.
      { app: OWNED_APP, listingId: 'apl_others' },
      // Another user's app, with its real listing id.
      { app: OTHERS_APP, listingId: 'apl_others' },
    ]) {
      const { status, json } = await attach(OWNER, body);
      expect(status).toBe(404);
      expect(json).toMatchObject({ code: 'NOT_FOUND' });
      expect(apis.get(OWNER)!.ingestAssetFromUrl).not.toHaveBeenCalled();
      expect(apis.get(OWNER)!.setCover).not.toHaveBeenCalled();
    }
  });

  it('attaches nothing to a listing whose media cannot be edited, saying why', async () => {
    const reason = 'This listing is locked while it is reviewed.';
    apiForMock.mockImplementation(() => {
      const api = fakeApi(OWNER);
      api.getMyListingForApp.mockResolvedValue({
        appListingId: 'apl_owned',
        status: 'pending',
        editBlockedReason: reason,
      });
      apis.set(OWNER, api);
      return api;
    });
    const { status, json } = await attach(OWNER, { app: OWNED_APP, listingId: 'apl_owned' });
    expect(status).toBe(409);
    expect(json).toEqual({ error: reason, code: 'CONFLICT' });
    expect(apis.get(OWNER)!.ingestAssetFromUrl).not.toHaveBeenCalled();
  });

  it('says why the cover check refused the image, and never an internal error’s text', async () => {
    const refusals: [TRPCError, string][] = [
      [
        new TRPCError({ code: 'BAD_REQUEST', message: 'cover must be landscape' }),
        'cover must be landscape',
      ],
      [
        new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'db host detail' }),
        'try again in a moment.',
      ],
    ];
    for (const [error, said] of refusals) {
      apiForMock.mockImplementation(() => {
        const api = fakeApi(OWNER);
        api.setCover.mockRejectedValue(error);
        return api;
      });
      const { status, json } = await attach(OWNER, { app: OWNED_APP, listingId: 'apl_owned' });
      expect(status).toBe(422);
      expect(json).toEqual({ error: said, code: 'not_attached' });
    }
  });
});
