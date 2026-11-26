import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Server calls to the main app's /api/mod, /api/admin and /api/internal routes go to its in-cluster
// address, never the public one, and production refuses to send them when that address is unset.

const env = vi.hoisted(() => ({} as Record<string, string | undefined>));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$env/dynamic/private', () => ({ env }));
// The fetch stub below stands in for the network; the Host dispatcher is covered by
// main-app-internal-url.test.ts against a real server.
vi.mock('../main-app-fetch', () => ({
  mainAppHostFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { grantCreatorScore, resetSubscriptionCaches } = await import('../user-actions.service');
const { syncSearchIndexBulk } = await import('../search-index');
const { evictHomeBlocks } = await import('../home-blocks');

const urls: string[] = [];

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, {
    CIVITAI_APP_URL: 'https://civitai.com',
    CIVITAI_INTERNAL_URL: 'http://main-web.internal:3000/',
    WEBHOOK_TOKEN: 'shared-secret',
    NODE_ENV: 'production',
  });
  urls.length = 0;
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify({ total: 1 }), { status: 200 }));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const calls = {
  'a session call (postJson)': () => grantCreatorScore({ userId: 1, amount: 1, reason: 'r' }),
  'a webhook call (callMainApp)': () => resetSubscriptionCaches({ userId: 1, moderatorId: 2 }),
  'the search-index callback': () =>
    syncSearchIndexBulk({ entityType: 'model', entityIds: [1], action: 'update' }),
  'the home-block refresh': () => evictHomeBlocks([1]),
};

describe.each(Object.entries(calls))('%s', (_, call) => {
  it('goes to the internal base, not the public one', async () => {
    await call();

    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith('http://main-web.internal:3000/api/')).toBe(true);
  });

  it('is not sent in production when the internal base is unset', async () => {
    delete env.CIVITAI_INTERNAL_URL;

    await call();

    expect(urls).toEqual([]);
  });

  it('falls back to the public base outside production', async () => {
    delete env.CIVITAI_INTERNAL_URL;
    env.NODE_ENV = 'development';

    await call();

    expect(urls[0].startsWith('https://civitai.com/api/')).toBe(true);
  });
});

it('a strict search-index sync throws in production when the internal base is unset', async () => {
  delete env.CIVITAI_INTERNAL_URL;

  await expect(
    syncSearchIndexBulk({ entityType: 'model', entityIds: [1], action: 'update' }, { strict: true })
  ).rejects.toThrow('CIVITAI_INTERNAL_URL');
  expect(urls).toEqual([]);
});

it('a refused call tells the operator why', async () => {
  delete env.CIVITAI_INTERNAL_URL;

  const result = await resetSubscriptionCaches({ userId: 1, moderatorId: 2 });

  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining('CIVITAI_INTERNAL_URL'),
  });
});
