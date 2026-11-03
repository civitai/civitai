import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/next-axiom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withAxiom: (handler: unknown) => handler,
}));
vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  instrumentApiResponse: () => undefined,
}));

const { TokenSecuredEndpoint } = await import('~/server/utils/endpoint-helpers');

const SECRET = 'a'.repeat(40);
const inner = vi.fn(async () => undefined);
const endpoint = TokenSecuredEndpoint(SECRET, inner) as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

async function call({
  query = {},
  headers = {},
}: {
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
}) {
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json: () => res,
  } as unknown as NextApiResponse;
  await endpoint({ query, headers } as unknown as NextApiRequest, res);
  return status;
}

beforeEach(() => inner.mockClear());

describe('TokenSecuredEndpoint', () => {
  it('refuses a wrong token of the same length', async () => {
    const wrong = 'a'.repeat(39) + 'b';
    expect(await call({ query: { token: wrong } })).toBe(401);
    expect(await call({ headers: { authorization: `Bearer ${wrong}` } })).toBe(401);
    expect(inner).not.toHaveBeenCalled();
  });

  it('accepts the token from an Authorization: Bearer header', async () => {
    expect(await call({ headers: { authorization: `Bearer ${SECRET}` } })).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('still accepts the token from the query string', async () => {
    expect(await call({ query: { token: SECRET } })).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('accepts the query token when an unrelated Bearer is also sent', async () => {
    expect(
      await call({
        query: { token: SECRET },
        headers: { authorization: 'Bearer some-session-jwt' },
      })
    ).toBe(200);
  });

  it('refuses a repeated query token rather than reading one of them', async () => {
    expect(await call({ query: { token: [SECRET, SECRET] } })).toBe(401);
    expect(inner).not.toHaveBeenCalled();
  });
});
