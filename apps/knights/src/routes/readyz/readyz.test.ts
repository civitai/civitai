import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => {
  throw new Error('the readiness route must not import auth');
});
vi.mock('$lib/server/db', () => {
  throw new Error('the readiness route must not import the database');
});
vi.mock('$lib/server/access', () => {
  throw new Error('the readiness route must not import Flipt');
});
const { ping } = vi.hoisted(() => ({ ping: vi.fn() }));
vi.mock('$lib/server/readiness', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/server/readiness')>();
  return { readiness: real.createReadiness({ ping }) };
});

const { GET } = await import('./+server');
const get = () => (GET as unknown as () => Promise<Response>)();

describe('GET /readyz', () => {
  it('answers 503 until the system Redis answers, then 200 ok, uncached, and stays ready', async () => {
    ping.mockRejectedValue(new Error('closed'));
    const before = await get();
    expect(before.status).toBe(503);
    expect(before.headers.get('cache-control')).toBe('no-store');

    ping.mockResolvedValue('PONG');
    const after = await get();
    expect(after.status).toBe(200);
    expect(await after.text()).toBe('ok');
    expect(after.headers.get('cache-control')).toBe('no-store');

    ping.mockRejectedValue(new Error('closed'));
    expect((await get()).status).toBe(200);
  });
});
