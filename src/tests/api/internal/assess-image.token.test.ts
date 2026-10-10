import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { setEnv } from '~/__tests__/mocks/env.mock';

// The endpoint derives its secret when the module is evaluated, so each case imports it fresh.
async function call(hiveToken: string | undefined, query: Record<string, unknown>) {
  setEnv({ HIVE_VISUAL_TOKEN: hiveToken });
  vi.resetModules();
  const { default: handler } = await import('~/pages/api/internal/assess-image');

  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  await handler(
    { method: 'GET', query, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return statusCode;
}

describe('assess-image with the upstream token unset', () => {
  it.each([
    ['the old placeholder', { token: 'dummy' }],
    ['an empty token', { token: '' }],
    ['no token', {}],
  ])('refuses %s as not configured', async (_label, query) => {
    expect(await call(undefined, query)).toBe(503);
  });

  it('POSITIVE CONTROL: a configured upstream token admits its derived secret', async () => {
    // Admitted, then refused by the method check: proof the request got past the token comparison.
    expect(await call('abcdefgh', { token: 'abcde' })).toBe(405);
  });

  it('POSITIVE CONTROL: a configured upstream token refuses the wrong secret', async () => {
    expect(await call('abcdefgh', { token: 'dummy' })).toBe(401);
  });
});
