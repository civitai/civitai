import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { setEnv } from '~/__tests__/mocks/env.mock';

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));

vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: mockGetSession }));

import handler from '~/pages/api/testing/model3d-seed';

async function call(secret: string | undefined, token: string) {
  setEnv({ WEBHOOK_TOKEN: secret });
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    setHeader: () => res,
    end: () => res,
  };
  await handler(
    { method: 'POST', query: { token }, headers: {}, body: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return statusCode;
}

describe('model3d-seed shared token', () => {
  beforeEach(() => {
    mockGetSession.mockReset().mockResolvedValue(null);
  });

  it('refuses whitespace against a whitespace secret without a moderator session', async () => {
    expect(await call('  ', '  ')).toBe(401);
  });

  it('POSITIVE CONTROL: the configured secret stands in for the moderator session', async () => {
    // Admitted, then refused by body validation.
    expect(await call('a-real-secret', 'a-real-secret')).toBe(400);
  });
});
