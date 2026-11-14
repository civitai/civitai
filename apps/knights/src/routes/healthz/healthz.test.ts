import { describe, expect, it, vi } from 'vitest';

// Any of these being imported by the route fails the test: the probe must answer from the process
// alone.
vi.mock('$lib/server/db', () => {
  throw new Error('the health route must not import the database');
});
vi.mock('$lib/server/redis', () => {
  throw new Error('the health route must not import Redis');
});
vi.mock('$lib/server/access', () => {
  throw new Error('the health route must not import Flipt');
});

const { GET } = await import('./+server');

describe('GET /healthz', () => {
  it('answers 200 ok, uncached', async () => {
    const response = await (GET as unknown as () => Response | Promise<Response>)();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
