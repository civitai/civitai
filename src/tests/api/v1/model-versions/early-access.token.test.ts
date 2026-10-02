import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { setEnv } from '~/__tests__/mocks/env.mock';

const { mockAssertMonetizationWrite, user } = vi.hoisted(() => ({
  mockAssertMonetizationWrite: vi.fn(),
  user: { id: 7, isModerator: false, meta: {} },
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, u: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, user),
}));
vi.mock('~/server/services/model-version.service', () => ({
  getVersionById: vi.fn(async () => ({ modelId: 11, baseModel: 'SDXL 1.0', licensingFee: null })),
  assertUserEarlyAccessLimits: vi.fn(),
  updateModelVersionPaidAccess: vi.fn(),
}));
vi.mock('~/server/services/model.service', () => ({
  getModel: vi.fn(async () => ({ userId: 7, poi: false, availability: 'Public' })),
  queueModelEarlyAccessReindex: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  assertMonetizationWrite: mockAssertMonetizationWrite,
}));
vi.mock('~/server/services/pricing-slot.service', () => ({
  recordPricingSlot: vi.fn(),
  releasePricingSlot: vi.fn(),
}));
vi.mock('~/server/services/subscriptions.service', () => ({ getCapTier: vi.fn() }));
vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlags: vi.fn(() => ({})) }));

import handler from '~/pages/api/v1/model-versions/early-access';

const PAST_THE_TOKEN_GATE = 'reached the monetization rules';

async function call(query: Record<string, unknown>) {
  let statusCode = 0;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
  };
  const req = {
    method: 'POST',
    query,
    headers: {},
    body: { id: 1, paidAccess: { permanent: true, terms: {} } },
  };
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return { statusCode, body };
}

describe('early-access shared token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertMonetizationWrite.mockRejectedValue(
      Object.assign(new Error(PAST_THE_TOKEN_GATE), { code: 'BAD_REQUEST' })
    );
  });

  it.each([
    ['an empty token against an empty secret', '', { token: '' }],
    ['whitespace against a whitespace secret', '  ', { token: '  ' }],
    ['no token against an unset secret', undefined, {}],
  ])('refuses %s', async (_label, secret, query) => {
    setEnv({ WEBHOOK_TOKEN: secret });

    const { statusCode } = await call(query);

    expect(statusCode).toBe(403);
    expect(mockAssertMonetizationWrite).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: the configured secret passes the token requirement', async () => {
    setEnv({ WEBHOOK_TOKEN: 'a-real-secret' });

    const { statusCode, body } = await call({ token: 'a-real-secret' });

    expect(body).toEqual({ error: PAST_THE_TOKEN_GATE });
    expect(statusCode).toBe(400);
  });

  it('POSITIVE CONTROL: a configured secret still refuses a wrong token', async () => {
    setEnv({ WEBHOOK_TOKEN: 'a-real-secret' });

    const { statusCode } = await call({ token: 'wrong' });

    expect(statusCode).toBe(403);
  });
});
