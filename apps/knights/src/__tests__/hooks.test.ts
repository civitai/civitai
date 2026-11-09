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

// `routeId` is SvelteKit's `event.route.id`: the path stands in for a real route, null is a URL no route answers.
async function run(path = '/', routeId: string | null = path.split('?')[0]) {
  const url = new URL(`https://knights.civitai.com${path}`);
  const resolve = vi.fn(async () => new Response('game', { status: 200 }));
  const response = await (handle as unknown as (arg: unknown) => Promise<Response>)({
    event: { url, request: page(url), locals: {}, route: { id: routeId } },
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
  it('shows an anonymous visitor the welcome page at /', async () => {
    guardCheck.mockResolvedValue({ status: 'login', redirect: 'https://auth.civitai.com/login' });
    const { response, resolve } = await run();
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalled();
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

  it('answers the /healthz probe without a session, access or standing lookup', async () => {
    guardCheck.mockResolvedValue({ status: 'login', redirect: 'https://auth.civitai.com/login' });
    const { response, resolve } = await run('/healthz');
    expect(resolve).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(guardCheck).not.toHaveBeenCalled();
    expect(accessFor).not.toHaveBeenCalled();
    expect(getStanding).not.toHaveBeenCalled();
  });

  it.each(['/healthzx', '/healthz/x', '/healthz/', '/api/healthz'])(
    'still guards %s: only /healthz itself is exempt',
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

  it('serves robots.txt to a crawler without a session', async () => {
    const { resolve } = await run('/robots.txt');
    expect(resolve).toHaveBeenCalled();
    expect(guardCheck).not.toHaveBeenCalled();
  });
});

describe('welcome screen', () => {
  const login = { status: 'login', redirect: 'https://auth.civitai.com/login?returnUrl=x' };

  it('sends a signed-out page load to the welcome page with the page it wanted', async () => {
    guardCheck.mockResolvedValue(login);
    const { response, resolve } = await run('/play');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?next=%2Fplay');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('serves the 404 for a signed-out page load no route answers, instead of a sign-in detour', async () => {
    guardCheck.mockResolvedValue(login);
    const { response, resolve } = await run('/no-such-page', null);
    expect(resolve).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it('keeps an unknown API path on the hub redirect', async () => {
    guardCheck.mockResolvedValue(login);
    const { response } = await run('/api/nothing-here', null);
    expect(response.headers.get('location')).toBe(login.redirect);
  });

  it('keeps an API request on the hub redirect', async () => {
    guardCheck.mockResolvedValue(login);
    const { response } = await run('/api/anything');
    expect(response.headers.get('location')).toBe(login.redirect);
  });

  it('renders the welcome page for a signed-out visitor, with the sign-in URL for the page they wanted', async () => {
    guardCheck.mockResolvedValue(login);
    const url = new URL('https://knights.civitai.com/?next=%2F%2Fevil.com');
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
    const url = new URL('https://knights.civitai.com/?next=%2Fplay%3Fa%3D1');
    await (handle as unknown as (arg: unknown) => Promise<Response>)({
      event: { url, request: page(url), locals: {}, route: { id: null } },
      resolve: vi.fn(async () => new Response('')),
    });
    expect(guardCheck.mock.calls[0][1]).toBe('https://knights.civitai.com/play?a=1');
  });

  it('runs the access gate for a signed-in user at /, so the page can send them home', async () => {
    accessFor.mockResolvedValue('allow');
    guardCheck.mockResolvedValue(signedIn({ id: 1 }));
    const locals: Record<string, unknown> = {};
    const url = new URL('https://knights.civitai.com/');
    const resolve = vi.fn(async () => new Response('home'));
    await (handle as unknown as (arg: unknown) => Promise<Response>)({
      event: { url, request: page(url), locals, route: { id: null } },
      resolve,
    });
    expect(accessFor).toHaveBeenCalled();
    expect(locals.user).toEqual({ id: 1 });
    expect(locals.signInUrl).toBeUndefined();
    expect(resolve).toHaveBeenCalled();
  });

  it('shows a signed-in user the rollout is closed to the not-open-yet page at /, not the welcome page', async () => {
    accessFor.mockResolvedValue('closed');
    guardCheck.mockResolvedValue(signedIn({ id: 7 }));
    const { response, resolve } = await run('/');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('not yet open');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('shuts a banned signed-in user out of / with the closed page', async () => {
    accessFor.mockResolvedValue('allow');
    getStanding.mockResolvedValue({ banned: true, muted: false });
    guardCheck.mockResolvedValue(signedIn({ id: 7, username: 'sir' }));
    const { response, resolve } = await run('/');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Your account can't enter the Order.");
    expect(resolve).not.toHaveBeenCalled();
  });

  it('renders the welcome page with the re-auth URL as its sign-in link when the session needs re-auth at /', async () => {
    guardCheck.mockResolvedValue({ status: 'reauth', authorize: 'https://auth.civitai.com/x' });
    const url = new URL('https://knights.civitai.com/');
    const locals: Record<string, unknown> = {};
    const resolve = vi.fn(async () => new Response('welcome'));
    const response = await (handle as unknown as (arg: unknown) => Promise<Response>)({
      event: { url, request: page(url), locals, route: { id: null } },
      resolve,
    });
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalled();
    expect(locals.signInUrl).toBe('https://auth.civitai.com/x');
    expect(locals.user).toBeUndefined();
    expect(accessFor).not.toHaveBeenCalled();
  });
});

describe('banned and muted accounts', () => {
  beforeEach(() => accessFor.mockResolvedValue('allow'));

  it.each(['/play', '/shop', '/judgments', '/ranks', '/rules', '/', '/api/anything'])(
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
    const { resolve } = await run('/shop');
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
