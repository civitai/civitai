import { describe, expect, it, vi } from 'vitest';
import { TokenSecuredEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Whoever is about to delete the not-configured branch: a blank secret used to be COMPARED, so
 * `?token=` with no value matched it and every endpoint on this wrapper answered as authenticated.
 * A bare key in a ConfigMap arrives blank, so that is a config typo away, not a hypothetical.
 */

function call(secret: string, query: Record<string, unknown>) {
  const handler = vi.fn(async (_req: never, res: { status: (c: number) => unknown }) => {
    res.status(200);
  });
  const endpoint = TokenSecuredEndpoint(secret, handler as never);

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
  return endpoint({ method: 'GET', query, headers: {} } as never, res as never).then(() => ({
    statusCode,
    handler,
  }));
}

describe('TokenSecuredEndpoint with no secret configured', () => {
  it('refuses an empty presented token against an empty secret, and runs nothing', async () => {
    const { statusCode, handler } = await call('', { token: '' });

    expect(statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses whitespace as a secret', async () => {
    const { statusCode, handler } = await call('   ', { token: '   ' });

    expect(statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a request presenting nothing against an empty secret', async () => {
    const { statusCode, handler } = await call('', {});

    expect(statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: a configured secret still admits the right token', async () => {
    const { statusCode, handler } = await call('a-real-secret', { token: 'a-real-secret' });

    expect(statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: a configured secret still refuses a wrong token with 401', async () => {
    const { statusCode, handler } = await call('a-real-secret', { token: 'wrong' });

    expect(statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a repeated token parameter, which arrives as an array', async () => {
    const { statusCode, handler } = await call('a-real-secret', {
      token: ['a-real-secret', 'x'],
    });

    expect(statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
