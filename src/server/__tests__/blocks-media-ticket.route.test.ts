import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveBlockMediaFetch } = vi.hoisted(() => ({ resolveBlockMediaFetch: vi.fn() }));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: unknown) => handler }));
vi.mock('~/server/services/blocks/block-media-serving', () => ({ resolveBlockMediaFetch }));

const handler = (await import('~/pages/api/v1/blocks/media/[ticket]')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

async function call(method: string, ticket: unknown = 'bm1.t') {
  const out: { status?: number; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      out.status = code;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ method, query: { ticket } } as unknown as NextApiRequest, res);
  return out;
}

beforeEach(() => resolveBlockMediaFetch.mockReset());

describe('GET /api/v1/blocks/media/[ticket]', () => {
  it('CONTROL: a served ticket redirects to its content, uncached', async () => {
    resolveBlockMediaFetch.mockResolvedValue({ state: 'redirect', location: 'https://cdn/x' });
    const r = await call('GET');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('https://cdn/x');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('🔴 a hidden ticket is a 404 with no location, uncached', async () => {
    resolveBlockMediaFetch.mockResolvedValue({ state: 'hidden', reason: 'blocked' });
    const r = await call('GET');
    expect(r.status).toBe(404);
    expect(r.headers.location).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('🔴 a pending ticket is a 409 with Retry-After and no location', async () => {
    resolveBlockMediaFetch.mockResolvedValue({ state: 'pending' });
    const r = await call('HEAD');
    expect(r.status).toBe(409);
    expect(r.headers['retry-after']).toBe('5');
    expect(r.headers.location).toBeUndefined();
  });

  it('passes an array-valued ticket through for the token reader to refuse', async () => {
    resolveBlockMediaFetch.mockResolvedValue({ state: 'hidden', reason: 'invalid' });
    expect((await call('GET', ['a', 'b'])).status).toBe(404);
    expect(resolveBlockMediaFetch).toHaveBeenCalledWith(['a', 'b']);
  });

  it('refuses other methods without judging the ticket', async () => {
    expect((await call('POST')).status).toBe(405);
    expect(resolveBlockMediaFetch).not.toHaveBeenCalled();
  });
});
