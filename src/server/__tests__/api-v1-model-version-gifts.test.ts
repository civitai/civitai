import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccountStanding from '~/server/services/account-standing.service';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as GiftService from '~/server/services/model-version-gift.service';
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

const USER = { id: 7, username: 'u', onboarding: 15, isModerator: false } as SessionUser;
const actor = { userId: 7, isModerator: false, modelVersionId: 5 };

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
    args: { userId: 7, code: 'cvg_abc' },
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
    args: { ...actor, count: 3 },
  },
  {
    name: 'POST link',
    path: '~/pages/api/v1/model-versions/[id]/gifts/link',
    method: 'POST',
    query: { id: '5' },
    body: { maxRedemptions: 4 },
    service: 'createGiftLink',
    args: { ...actor, maxRedemptions: 4 },
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
];
const WRITES = ROUTES.filter((r) => r.method !== 'GET');

const token = (tokenScope: number) => ({ tokenScope, apiKeyId: 3, subject: { type: 'apiKey' } });

async function call(
  route: (typeof ROUTES)[number],
  context: Record<string, unknown>,
  user: SessionUser = USER
) {
  const out = { status: 0 };
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
    json: () => res,
    setHeader: () => res,
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
