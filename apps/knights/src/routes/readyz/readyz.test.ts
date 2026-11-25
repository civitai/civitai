import { beforeEach, describe, expect, it, vi } from 'vitest';

// The readiness probe answers from Redis alone: it must never reach the user guard, the revocation
// check, the database or Flipt.
vi.mock('$lib/server/auth', () => {
  throw new Error('the readiness route must not import auth');
});
vi.mock('$lib/server/db', () => {
  throw new Error('the readiness route must not import the database');
});
vi.mock('$lib/server/access', () => {
  throw new Error('the readiness route must not import Flipt');
});
const { check } = vi.hoisted(() => ({ check: vi.fn(async () => false) }));
vi.mock('$lib/server/readiness', () => ({ readiness: { check } }));

const { GET } = await import('./+server');
const get = () => (GET as unknown as () => Promise<Response>)();

beforeEach(() => {
  check.mockReset();
});

describe('GET /readyz', () => {
  it('answers 503 until the system Redis has answered', async () => {
    check.mockResolvedValue(false);
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 200 ok once ready, uncached', async () => {
    check.mockResolvedValue(true);
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
