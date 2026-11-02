import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';

/**
 * App Assistant's server runner reads the open app's moderator review and its users' feedback FOR
 * the user its run grant names: `/api/internal/app-assistant/app-feedback/{review,user}`.
 *
 * The routes run with the REAL grant verification and the REAL lookup
 * (`createAppFeedbackSource`); mocked are the user gates (`getRunnerDevTunnelUser`, covered in
 * app-assistant.service.test.ts) and civitai's three author reads, whose own role checks are
 * covered by their services' tests. What is pinned here: which user the reads run as, and that an
 * app of anyone else's answers exactly as an app with no listing.
 */

const { runnerUserMock, listMineMock, historyMock, feedbackMock } = vi.hoisted(() => ({
  runnerUserMock: vi.fn(),
  listMineMock: vi.fn(),
  historyMock: vi.fn(),
  feedbackMock: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  getRunnerDevTunnelUser: runnerUserMock,
}));
vi.mock('~/server/services/blocks/app-access.service', () => ({
  listMyAppListings: listMineMock,
}));
vi.mock('~/server/services/blocks/app-listing-history.service', () => ({
  listListingHistory: historyMock,
}));
vi.mock('~/server/services/blocks/app-feedback.service', () => ({
  listAppFeedbackForListing: feedbackMock,
}));

const { signRunGrant } = await import('~/server/services/app-assistant/assistant-runner-tokens');
const reviewRoute = (await import('~/pages/api/internal/app-assistant/app-feedback/review'))
  .default;
const userRoute = (await import('~/pages/api/internal/app-assistant/app-feedback/user')).default;

// TEST-ONLY values: a key pair generated for this run and a placeholder secret.
const SECRET = 'test-only-runner-secret-for-feedback';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Pairwise-distinct: two users, each with one app; listing ids share no digits with user ids.
const OWNER = 4101;
const OTHER = 4202;
const OWNED_APP = 'alpha-app';
const OTHERS_APP = 'beta-app';
const OWNED_LISTING = 'lst_alpha_73';
const OTHERS_LISTING = 'lst_beta_86';
const LISTINGS: Record<number, object[]> = {
  [OWNER]: [
    {
      appListingId: OWNED_LISTING,
      slug: OWNED_APP,
      status: 'rejected',
      role: 'owner',
      problems: [{ code: 'missing_icon', label: 'Add an icon', severity: 'blocking' }],
    },
  ],
  [OTHER]: [
    {
      appListingId: OTHERS_LISTING,
      slug: OTHERS_APP,
      status: 'approved',
      role: 'owner',
      problems: [],
    },
  ],
};

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;

async function call(handler: Handler, body: unknown, headers = asRunner) {
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
    setHeader() {
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', headers, body, query: {} } as unknown as NextApiRequest, res);
  return { status, json };
}

const asRunner = { authorization: `Bearer ${SECRET}` };
const grantFor = async (userId: number) =>
  (await signRunGrant({ userId, conversationId: `c-${userId}`, idempotencyKey: `k-${userId}` }))
    .token;

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({
    ASSISTANT_RUNNER_SECRET: SECRET,
    ASSISTANT_RUNNER_SIGNING_KEY: SIGNING_KEY,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
  });
  runnerUserMock.mockImplementation(async (userId: number) => ({
    refusal: null,
    user: { id: userId },
  }));
  listMineMock.mockImplementation(async ({ userId }: { userId: number }) => LISTINGS[userId] ?? []);
  historyMock.mockImplementation(async () => [
    {
      source: 'version',
      version: '1.0.0',
      status: 'rejected',
      submittedAt: new Date('2026-10-20T10:00:00Z'),
      reviewedAt: new Date('2026-10-21T10:00:00Z'),
      rejectionReason: 'Crashes on load.',
      approvalNotes: null,
      deployState: null,
      deployDetail: null,
      canWithdraw: false,
    },
  ]);
  feedbackMock.mockImplementation(async () => ({
    items: [
      {
        id: 9001,
        message: 'Love it',
        createdAt: new Date('2026-10-22T10:00:00Z'),
        reporter: { id: 777, username: 'someone' },
        appBlockVersion: '1.0.0',
        appBlockSha: 'abc',
        surface: 'page',
        ownerStatus: null,
        ownerStatusAt: null,
        ownerFlaggedAt: null,
      },
    ],
    nextCursor: undefined,
  }));
});

describe('the runner’s secret and run grant', () => {
  it.each([
    ['review', reviewRoute],
    ['user', userRoute],
  ])('%s: 401 to a wrong secret or a forged grant, reading nothing', async (_, route) => {
    const grant = await grantFor(OWNER);
    expect(
      (await call(route, { grant, app: OWNED_APP }, { authorization: 'Bearer nope' })).status
    ).toBe(401);
    const forged = await call(route, { grant: 'not-a-grant', app: OWNED_APP });
    expect(forged).toMatchObject({ status: 401, json: { code: 'invalid_grant' } });
    expect(listMineMock).not.toHaveBeenCalled();
  });
});

describe('POST …/app-feedback/review', () => {
  it('reads the grant’s user’s own app, as My apps shows it', async () => {
    const { status, json } = await call(reviewRoute, {
      grant: await grantFor(OWNER),
      app: OWNED_APP,
    });
    expect(status).toBe(200);
    expect(listMineMock).toHaveBeenCalledWith({ userId: OWNER });
    expect(historyMock).toHaveBeenCalledWith({ appListingId: OWNED_LISTING, userId: OWNER });
    expect(json).toEqual({
      listing: { status: 'rejected', problems: [{ label: 'Add an icon', blocking: true }] },
      submissions: [
        {
          kind: 'version',
          version: '1.0.0',
          status: 'rejected',
          submittedAt: '2026-10-20T10:00:00.000Z',
          reviewedAt: '2026-10-21T10:00:00.000Z',
          rejectionReason: 'Crashes on load.',
          approvalNotes: null,
          deployState: null,
          deployProblem: null,
        },
      ],
    });
  });

  it('answers another user’s app exactly as an app with no listing: 404, nothing read by id', async () => {
    const grant = await grantFor(OWNER);
    const foreign = await call(reviewRoute, { grant, app: OTHERS_APP });
    const missing = await call(reviewRoute, { grant, app: 'never-submitted' });
    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
    expect(historyMock).not.toHaveBeenCalled();
  });

  it('passes a gate refusal through and reads nothing', async () => {
    runnerUserMock.mockResolvedValueOnce({
      refusal: {
        status: 403,
        error: 'You do not have access to Apps authoring',
        code: 'FORBIDDEN',
      },
    });
    const { status, json } = await call(reviewRoute, {
      grant: await grantFor(OWNER),
      app: OWNED_APP,
    });
    expect(status).toBe(403);
    expect(json).toEqual({ error: 'You do not have access to Apps authoring', code: 'FORBIDDEN' });
    expect(listMineMock).not.toHaveBeenCalled();
  });
});

describe('POST …/app-feedback/user', () => {
  it('reads the inbox as the grant’s user, without who wrote each item', async () => {
    const { status, json } = await call(userRoute, {
      grant: await grantFor(OWNER),
      app: OWNED_APP,
      status: 'all',
      limit: 5,
    });
    expect(status).toBe(200);
    expect(feedbackMock).toHaveBeenCalledWith({
      userId: OWNER,
      input: { appListingId: OWNED_LISTING, limit: 5 },
    });
    expect(json).toEqual({
      appListingId: OWNED_LISTING,
      items: [
        {
          id: 9001,
          createdAt: '2026-10-22T10:00:00.000Z',
          status: 'new',
          appVersion: '1.0.0',
          message: 'Love it',
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(json)).not.toContain('someone');
  });

  it('defaults to new items, 20 at a time', async () => {
    await call(userRoute, { grant: await grantFor(OWNER), app: OWNED_APP });
    expect(feedbackMock).toHaveBeenCalledWith({
      userId: OWNER,
      input: { appListingId: OWNED_LISTING, limit: 20, ownerStatus: 'new' },
    });
  });

  it('another user’s app: 404, the inbox never asked', async () => {
    const res = await call(userRoute, { grant: await grantFor(OWNER), app: OTHERS_APP });
    expect(res).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
    expect(feedbackMock).not.toHaveBeenCalled();
  });

  it('a role lost between the lookup and the read is the same 404', async () => {
    feedbackMock.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN', message: 'no' }));
    const res = await call(userRoute, { grant: await grantFor(OWNER), app: OWNED_APP });
    expect(res).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
  });

  it('refuses a limit past 50 as a bad body', async () => {
    const res = await call(userRoute, { grant: await grantFor(OWNER), app: OWNED_APP, limit: 51 });
    expect(res.status).toBe(400);
    expect(feedbackMock).not.toHaveBeenCalled();
  });

  it('an unexpected failure is 503 unavailable, its text kept out of the answer', async () => {
    feedbackMock.mockRejectedValueOnce(new Error('connection to db-host-1 refused'));
    const res = await call(userRoute, { grant: await grantFor(OWNER), app: OWNED_APP });
    expect(res).toMatchObject({ status: 503, json: { code: 'unavailable' } });
    expect(JSON.stringify(res.json)).not.toContain('db-host');
  });
});
