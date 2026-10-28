import { beforeEach, describe, expect, it, vi } from 'vitest';

const { guardCheck } = vi.hoisted(() => ({
  guardCheck: vi.fn(async (..._: unknown[]) => ({} as unknown)),
}));
vi.mock('$lib/server/auth', () => ({ guard: { check: guardCheck } }));
const { accessFor } = vi.hoisted(() => ({
  accessFor: vi.fn(async (..._: unknown[]) => 'closed' as 'allow' | 'closed'),
}));
vi.mock('$lib/server/access', () => ({ accessFor }));

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
  accessFor.mockReset().mockResolvedValue('closed');
});

describe('knights access gate', () => {
  it('sends an anonymous visitor to the auth hub sign-in', async () => {
    guardCheck.mockResolvedValue({ status: 'login', redirect: 'https://auth.civitai.com/login' });
    const { response, resolve } = await run();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://auth.civitai.com/login');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lets a user through when the access decision allows them', async () => {
    accessFor.mockResolvedValue('allow');
    guardCheck.mockResolvedValue(signedIn({ id: 1, isModerator: true }));
    const { response, resolve } = await run();
    expect(resolve).toHaveBeenCalled();
    expect(await response.text()).toBe('game');
  });

  it('shows everyone else the not-open-yet page', async () => {
    guardCheck.mockResolvedValue(signedIn({ id: 7 }));
    const { response, resolve } = await run();
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('not yet open');
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['/api/jobs/tick', '/api/jobs/partitions'])(
    'lets the job route %s skip the user guard',
    async (path) => {
      const { resolve } = await run(path);
      expect(resolve).toHaveBeenCalled();
      expect(guardCheck).not.toHaveBeenCalled();
    }
  );

  it.each(['/api/jobs/', '/api/jobs/other', '/api/jobs/tick/extra', '/api/jobs/tick/'])(
    'still guards %s: only the two job routes are exempt',
    async (path) => {
      guardCheck.mockResolvedValue({ status: 'login', redirect: 'https://auth.civitai.com/login' });
      const { response, resolve } = await run(path);
      expect(guardCheck).toHaveBeenCalled();
      expect(response.status).toBe(302);
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it('serves the sign-in routes without a session', async () => {
    const { resolve } = await run('/api/auth/callback');
    expect(resolve).toHaveBeenCalled();
    expect(guardCheck).not.toHaveBeenCalled();
  });
});
