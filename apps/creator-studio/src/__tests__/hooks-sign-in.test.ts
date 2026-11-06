import { beforeEach, describe, expect, it, vi } from 'vitest';

// Load-time mocks: the hook module reads private env, stamps the build version, and imports the DB pool and logger.
const { guardCheck } = vi.hoisted(() => {
  vi.stubGlobal('__APP_VERSION__', 'test');
  return { guardCheck: vi.fn(async (..._args: unknown[]) => ({}) as unknown) };
});
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/auth', () => ({ guard: { check: guardCheck } }));
vi.mock('$lib/server/db', () => ({ dbPool: {} }));
vi.mock('$lib/server/logger', () => ({
  getLogger: () => ({ logToAxiom: async () => undefined }),
}));

const { handle } = await import('../hooks.server');

async function run(path: string, init: RequestInit = {}) {
  const url = new URL(`https://creators.civitai.com${path}`);
  const resolve = vi.fn(async () => new Response(null, { status: 204 }));
  const response = await (handle as unknown as (arg: unknown) => Promise<Response>)({
    event: { url, request: new Request(url, init), locals: {}, route: { id: null } },
    resolve,
  });
  return { response, resolve };
}

beforeEach(() => guardCheck.mockReset());

describe('creator-studio sign-in wiring', () => {
  it.each(['/api/auth/authorize', '/api/auth/callback'])(
    '%s is reached without a session',
    async (path) => {
      const { response, resolve } = await run(path);
      expect(resolve).toHaveBeenCalled();
      expect(response.status).toBe(204);
      expect(guardCheck).not.toHaveBeenCalled();
    }
  );

  it('a fetch whose session is gone gets a 401 carrying the sign-in URL', async () => {
    const authorize = 'https://creators.civitai.com/api/auth/authorize?returnUrl=%2Fdashboard';
    guardCheck.mockResolvedValue({ status: 'reauth', authorize });
    const { response, resolve } = await run('/dashboard', {
      headers: { 'sec-fetch-mode': 'cors' },
    });
    expect(guardCheck.mock.calls[0][2]).toEqual({ navigation: false });
    expect(response.status).toBe(401);
    expect(response.headers.get('x-session-reauth')).toBe(authorize);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a rolled session reaches the browser on the response', async () => {
    guardCheck.mockResolvedValue({
      status: 'ok',
      user: { id: 7 },
      setCookies: ['__Host-civ-token=fresh; Path=/; HttpOnly; SameSite=Lax; Secure'],
    });
    const { response } = await run('/api/anything', { headers: { 'sec-fetch-mode': 'navigate' } });
    expect(guardCheck.mock.calls[0][2]).toEqual({ navigation: true });
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-civ-token=fresh; Path=/; HttpOnly; SameSite=Lax; Secure',
    ]);
  });
});
