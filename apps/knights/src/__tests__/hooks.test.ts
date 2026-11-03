import { beforeEach, describe, expect, it, vi } from 'vitest';

const { guardCheck } = vi.hoisted(() => ({
  guardCheck: vi.fn(async (..._: unknown[]) => ({} as unknown)),
}));
vi.mock('$lib/server/auth', () => ({ guard: { check: guardCheck } }));
const { accessFor } = vi.hoisted(() => ({
  accessFor: vi.fn(async (..._: unknown[]) => 'closed' as 'allow' | 'closed'),
}));
vi.mock('$lib/server/access', () => ({ accessFor }));
vi.mock('$lib/server/db', () => ({ db: {} }));
const { getStanding } = vi.hoisted(() => ({
  getStanding: vi.fn(async (..._: unknown[]) => ({ banned: false, muted: false })),
}));
vi.mock('$lib/server/standing', () => ({ getStanding }));

const { handle } = await import('../hooks.server');

const page = (url: URL) => new Request(url, { headers: { 'sec-fetch-mode': 'navigate' } });

async function run(path = '/') {
  const url = new URL(`https://knights.civitai.com${path}`);
  const resolve = vi.fn(async () => new Response('game', { status: 200 }));
  const response = await (handle as unknown as (arg: unknown) => Promise<Response>)({
    event: { url, request: page(url), locals: {}, route: { id: null } },
    resolve,
  });
  return { response, resolve };
}

const signedIn = (user: object) => ({ status: 'ok', user, setCookies: [] });

beforeEach(() => {
  guardCheck.mockReset();
  accessFor.mockReset().mockResolvedValue('closed');
  getStanding.mockReset().mockResolvedValue({ banned: false, muted: false });
});

describe('knights access gate', () => {
  it('sends an anonymous visitor to the welcome screen', async () => {
    guardCheck.mockResolvedValue({ status: 'login', redirect: 'https://auth.civitai.com/login' });
    const { response, resolve } = await run();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/welcome');
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

describe('welcome screen', () => {
  const login = { status: 'login', redirect: 'https://auth.civitai.com/login?returnUrl=x' };

  it('sends a signed-out page load to /welcome with the page it wanted', async () => {
    guardCheck.mockResolvedValue(login);
    const { response, resolve } = await run('/play');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/welcome?next=%2Fplay');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps an API request on the hub redirect', async () => {
    guardCheck.mockResolvedValue(login);
    const { response } = await run('/api/anything');
    expect(response.headers.get('location')).toBe(login.redirect);
  });

  it('renders /welcome for a signed-out visitor, with the sign-in URL for the page they wanted', async () => {
    guardCheck.mockResolvedValue(login);
    const url = new URL('https://knights.civitai.com/welcome?next=%2F%2Fevil.com');
    const locals: Record<string, unknown> = {};
    const resolve = vi.fn(async () => new Response('welcome'));
    await (handle as unknown as (arg: unknown) => Promise<Response>)({
      event: { url, request: page(url), locals, route: { id: null } },
      resolve,
    });
    expect(resolve).toHaveBeenCalled();
    expect(locals.signInUrl).toBe(login.redirect);
    expect(guardCheck.mock.calls[0][1]).toBe('https://knights.civitai.com/');
  });

  it('asks the hub to return to the sanitised next page', async () => {
    guardCheck.mockResolvedValue(login);
    const url = new URL('https://knights.civitai.com/welcome?next=%2Fplay%3Fa%3D1');
    await (handle as unknown as (arg: unknown) => Promise<Response>)({
      event: { url, request: page(url), locals: {}, route: { id: null } },
      resolve: vi.fn(async () => new Response('')),
    });
    expect(guardCheck.mock.calls[0][1]).toBe('https://knights.civitai.com/play?a=1');
  });

  it('sends a signed-in user from /welcome to /', async () => {
    guardCheck.mockResolvedValue(signedIn({ id: 1 }));
    const { response, resolve } = await run('/welcome');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('banned and muted accounts', () => {
  beforeEach(() => accessFor.mockResolvedValue('allow'));

  it.each(['/play', '/gold', '/judgments', '/ranks', '/rules', '/', '/api/anything'])(
    'shuts a banned user out of %s with the closed page',
    async (path) => {
      getStanding.mockResolvedValue({ banned: true, muted: false });
      guardCheck.mockResolvedValue(signedIn({ id: 7, username: 'sir' }));
      const { response, resolve } = await run(path);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Your account can't enter the Order.");
      expect(resolve).not.toHaveBeenCalled();
      expect(getStanding).toHaveBeenCalledWith(expect.anything(), 7);
    }
  );

  it('keeps a banned moderator out too', async () => {
    getStanding.mockResolvedValue({ banned: true, muted: false });
    guardCheck.mockResolvedValue(signedIn({ id: 7, isModerator: true }));
    const { response, resolve } = await run('/play');
    expect(response.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lets a muted user in: muting only stops judging', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    guardCheck.mockResolvedValue(signedIn({ id: 7 }));
    const { resolve } = await run('/play');
    expect(resolve).toHaveBeenCalled();
  });

  it('lets a user in good standing through', async () => {
    guardCheck.mockResolvedValue(signedIn({ id: 7 }));
    const { resolve } = await run('/gold');
    expect(resolve).toHaveBeenCalled();
  });

  it('does not look the user up on a job route', async () => {
    await run('/api/jobs/tick');
    expect(getStanding).not.toHaveBeenCalled();
  });

  it('does not look up a user the rollout already closed out', async () => {
    accessFor.mockResolvedValue('closed');
    guardCheck.mockResolvedValue(signedIn({ id: 7 }));
    const { response } = await run('/play');
    expect(await response.text()).toContain('not yet open');
    expect(getStanding).not.toHaveBeenCalled();
  });
});
