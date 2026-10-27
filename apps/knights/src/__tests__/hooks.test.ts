import { beforeEach, describe, expect, it, vi } from 'vitest';

const { guardCheck } = vi.hoisted(() => ({
  guardCheck: vi.fn(async (..._: unknown[]) => ({} as unknown)),
}));
vi.mock('$lib/server/auth', () => ({ guard: { check: guardCheck } }));

const { handle } = await import('../hooks.server');

async function run(path = '/') {
  const url = new URL(`https://knights.civitai.com${path}`);
  const resolve = vi.fn(async () => new Response('game', { status: 200 }));
  const response = await (handle as unknown as (arg: unknown) => Promise<Response>)({
    event: { url, request: new Request(url), locals: {}, route: { id: null } },
    resolve,
  });
  return { response, resolve };
}

const signedIn = (user: object) => ({ status: 'ok', user, setCookies: [] });

beforeEach(() => {
  guardCheck.mockReset();
  process.env.KNIGHTS_TESTER_USER_IDS = '42';
});

describe('knights access gate', () => {
  it('sends an anonymous visitor to the auth hub sign-in', async () => {
    guardCheck.mockResolvedValue({ status: 'login', redirect: 'https://auth.civitai.com/login' });
    const { response, resolve } = await run();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://auth.civitai.com/login');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lets a moderator through', async () => {
    guardCheck.mockResolvedValue(signedIn({ id: 1, isModerator: true }));
    const { response, resolve } = await run();
    expect(resolve).toHaveBeenCalled();
    expect(await response.text()).toBe('game');
  });

  it('lets a listed tester through', async () => {
    guardCheck.mockResolvedValue(signedIn({ id: 42 }));
    const { resolve } = await run();
    expect(resolve).toHaveBeenCalled();
  });

  it('shows everyone else the not-open-yet page', async () => {
    guardCheck.mockResolvedValue(signedIn({ id: 7 }));
    const { response, resolve } = await run();
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('not yet open');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('serves the sign-in routes without a session', async () => {
    const { resolve } = await run('/api/auth/callback');
    expect(resolve).toHaveBeenCalled();
    expect(guardCheck).not.toHaveBeenCalled();
  });
});
