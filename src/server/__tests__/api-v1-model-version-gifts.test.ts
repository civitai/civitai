import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccountStanding from '~/server/services/account-standing.service';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as GiftService from '~/server/services/model-version-gift.service';
import { throwRateLimited } from '~/server/utils/rate-limit-error';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

const BATCH = '0b6f6a3e-6a77-4d8a-9a2e-0c6f2c1d9a11';

const { svc, flags, standing } = vi.hoisted(() => ({
  svc: {
    claimGift: vi.fn(async () => ({ modelVersionId: 1, modelId: 2, alreadyHadAccess: false })),
    createGiftLink: vi.fn(async () => ({ id: 1, code: 'cvg_x' })),
    mintGiftCodes: vi.fn(async () => ({ batchId: 'b', codes: [] })),
    listGiftLinks: vi.fn(async () => ({ links: [], batches: [] })),
    revokeGiftLinks: vi.fn(async () => ({ revoked: 1 })),
    removeGiftClaim: vi.fn(async () => ({ removed: true })),
  },
  flags: { modelGiftLinks: true },
  standing: { muted: false },
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsAsync: async () => flags,
}));
vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountStanding>()),
  isAccountMuted: async () => standing.muted,
}));
vi.mock('~/server/services/model-version-gift.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GiftService>()),
  ...svc,
}));

type Handler = (req: NextApiRequest, res: NextApiResponse, user: SessionUser) => Promise<void>;
const load = async (path: string) => (await import(path)).default as Handler;

const USER = {
  id: 7,
  username: 'u',
  onboarding: 15,
  isModerator: false,
  tier: 'gold',
} as SessionUser;
const actor = { userId: 7, isModerator: false, modelVersionId: 5 };
// Minting is owner-only, so the mint routes never hand the service a moderator flag.
const owner = { userId: 7, modelVersionId: 5 };

// Every gift route, with a request that passes validation, and what it must hand the service.
const ROUTES: Array<{
  name: string;
  path: string;
  method: string;
  query: object;
  body?: object;
  service: keyof typeof svc;
  args: object;
}> = [
  {
    name: 'POST claim',
    path: '~/pages/api/v1/model-versions/gifts/claim',
    method: 'POST',
    query: {},
    body: { code: 'cvg_abc', userId: 999 },
    service: 'claimGift',
    // The session user, for the monthly allowance's tier; never an id from the body.
    args: { user: expect.objectContaining({ id: 7, tier: 'gold' }), code: 'cvg_abc' },
  },
  {
    name: 'GET list',
    path: '~/pages/api/v1/model-versions/[id]/gifts/index',
    method: 'GET',
    query: { id: '5' },
    service: 'listGiftLinks',
    args: actor,
  },
  {
    name: 'POST mint',
    path: '~/pages/api/v1/model-versions/[id]/gifts/index',
    method: 'POST',
    query: { id: '5' },
    body: { count: 3 },
    service: 'mintGiftCodes',
    args: { ...owner, count: 3 },
  },
  {
    name: 'POST link',
    path: '~/pages/api/v1/model-versions/[id]/gifts/link',
    method: 'POST',
    query: { id: '5' },
    body: { maxRedemptions: 4 },
    service: 'createGiftLink',
    args: { ...owner, maxRedemptions: 4 },
  },
  {
    name: 'DELETE one',
    path: '~/pages/api/v1/model-versions/[id]/gifts/[giftId]',
    method: 'DELETE',
    query: { id: '5', giftId: '9' },
    service: 'revokeGiftLinks',
    args: { ...actor, id: 9 },
  },
  {
    name: 'DELETE batch',
    path: '~/pages/api/v1/model-versions/[id]/gifts/batch/[batchId]',
    method: 'DELETE',
    query: { id: '5', batchId: BATCH },
    service: 'revokeGiftLinks',
    args: { ...actor, batchId: BATCH },
  },
  {
    name: 'DELETE claim',
    path: '~/pages/api/v1/model-versions/[id]/gifts/[giftId]/claims/[userId]',
    method: 'DELETE',
    query: { id: '5', giftId: '9', userId: '20' },
    service: 'removeGiftClaim',
    args: { ...actor, giftLinkId: 9, claimerId: 20 },
  },
];
const WRITES = ROUTES.filter((r) => r.method !== 'GET');

const token = (tokenScope: number) => ({ tokenScope, apiKeyId: 3, subject: { type: 'apiKey' } });

async function call(
  route: (typeof ROUTES)[number],
  context: Record<string, unknown>,
  user: SessionUser = USER
) {
  const out = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const req = {
    method: route.method,
    headers: {},
    query: route.query,
    body: route.body,
    context,
  } as unknown as NextApiRequest;
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json: (body: unknown) => {
      out.body = body;
      return res;
    },
    setHeader: (name: string, value: string) => {
      out.headers[name] = value;
      return res;
    },
  } as unknown as NextApiResponse;
  await (
    await load(route.path)
  )(req, res, user);
  return out;
}

const serviceCalls = () => Object.values(svc).reduce((n, fn) => n + fn.mock.calls.length, 0);

beforeEach(() => {
  Object.values(svc).forEach((fn) => fn.mockClear());
  flags.modelGiftLinks = true;
  standing.muted = false;
});

describe.each(ROUTES)('$name', (route) => {
  it.each([
    ['a ModelsRead-only key', token(TokenScope.ModelsRead)],
    ['a key with no model scope', token(TokenScope.UserRead | TokenScope.MediaWrite)],
  ])('refuses %s with 403 before calling the service', async (_label, context) => {
    expect((await call(route, context)).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });

  it.each([
    ['a cookie session', {}],
    ['a ModelsWrite key', token(TokenScope.ModelsWrite)],
    ['a full-access key', token(TokenScope.Full)],
  ])('serves %s, handing the service the caller and the path ids', async (_label, context) => {
    expect([200, 201]).toContain((await call(route, context)).status);
    expect(serviceCalls()).toBe(1);
    expect(svc[route.service]).toHaveBeenCalledWith(expect.objectContaining(route.args));
  });

  it('answers 404 while modelGiftLinks is off', async () => {
    flags.modelGiftLinks = false;
    expect((await call(route, {})).status).toBe(404);
    expect(serviceCalls()).toBe(0);
  });
});

describe.each(WRITES)('$name applies the tRPC write gates', (route) => {
  it.each([
    ['a user who has not finished onboarding', { ...USER, onboarding: 0 }],
    [
      'a user who must verify their email',
      { ...USER, emailVerified: null, meta: { emailVerificationRequired: true } },
    ],
  ])('refuses %s', async (_label, user) => {
    expect((await call(route, {}, user as SessionUser)).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });

  it('refuses a muted user', async () => {
    standing.muted = true;
    expect((await call(route, {})).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });
});

it('still lists for a user the write gates would refuse', async () => {
  const list = ROUTES.find((r) => r.method === 'GET')!;
  expect((await call(list, {}, { ...USER, onboarding: 0 } as SessionUser)).status).toBe(200);
});

it.each(ROUTES.filter((r) => r.service === 'mintGiftCodes' || r.service === 'createGiftLink'))(
  '$name never hands the service a moderator flag, so a moderator cannot mint',
  async (route) => {
    await call(route, {}, { ...USER, isModerator: true } as SessionUser);
    expect(svc[route.service]).toHaveBeenCalledTimes(1);
    const [args] = svc[route.service].mock.calls[0] as unknown[];
    expect(args).not.toHaveProperty('isModerator');
  }
);

it.each(
  ROUTES.filter((r) => ['listGiftLinks', 'revokeGiftLinks', 'removeGiftClaim'].includes(r.service))
)(
  '$name hands the service the caller’s moderator flag, so a moderator can list and revoke',
  async (route) => {
    await call(route, {}, { ...USER, isModerator: true } as SessionUser);
    expect(svc[route.service]).toHaveBeenCalledWith(
      expect.objectContaining({ ...route.args, isModerator: true })
    );
  }
);

it.each([
  { id: '5', giftId: '9', userId: 'x' },
  { id: '5', giftId: '0', userId: '20' },
  { id: 'x', giftId: '9', userId: '20' },
])('DELETE claim refuses %o with 400 before calling the service', async (query) => {
  const route = { ...ROUTES.find((r) => r.name === 'DELETE claim')!, query };
  expect((await call(route, {})).status).toBe(400);
  expect(serviceCalls()).toBe(0);
});

describe('POST link cap', () => {
  const link = ROUTES.find((r) => r.name === 'POST link')!;

  it('gives a link with no cap named the default of 10', async () => {
    expect((await call({ ...link, body: {} }, {})).status).toBe(201);
    expect(svc.createGiftLink).toHaveBeenCalledWith(
      expect.objectContaining({ maxRedemptions: 10 })
    );
  });

  it.each([null, 0, 101, 2.5])('refuses maxRedemptions %s with 400', async (maxRedemptions) => {
    expect((await call({ ...link, body: { maxRedemptions } }, {})).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it('takes a cap of 100', async () => {
    expect((await call({ ...link, body: { maxRedemptions: 100 } }, {})).status).toBe(201);
  });
});

it('answers a claim past the monthly allowance with 429, Retry-After and the limit', async () => {
  const rateLimit = {
    retryAfterSeconds: 3600,
    retryAt: '2026-12-01T00:00:00.000Z',
    id: 'gifts.monthly',
    kind: 'product' as const,
    limit: 3,
    used: 3,
    remaining: 0,
    windowSeconds: 2592000,
    resetAt: '2026-12-01T00:00:00.000Z',
  };
  svc.claimGift.mockImplementationOnce(async () => throwRateLimited(rateLimit, 'Monthly limit.'));
  const out = await call(ROUTES.find((r) => r.name === 'POST claim')!, {});
  expect(out.status).toBe(429);
  expect(out.headers['Retry-After']).toBe('3600');
  expect(out.body).toMatchObject({ message: 'Monthly limit.', rateLimit });
});
