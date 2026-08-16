/**
 * Pins the read deadlines in `/api/user/settings`.
 *
 * Every I/O member in that handler already had a `.catch` fallback, which answers a
 * REJECTION. None of them answered a dependency that accepts the read and never replies —
 * and `_app.getInitialProps` awaits this route on every SSR render, so one parked read
 * pinned EVERY page at the client's abort (8s) and rendered it signed-out, with nothing
 * logged. Measured 2026-08-16: `getUserContentSettings`, `getCurrentAnnouncements` and
 * `getLiveNow` all hung together against one bad dependency.
 *
 * Deliberately NOT covered: `getServerAuthSession`. It is awaited unguarded on purpose —
 * failing it open renders a logged-in user anonymous, and `_app`'s `hasAuthCookie`
 * carve-out exists precisely because that is worse than a slow page.
 *
 * Lives outside `src/pages`: Next treats every file under there as a route and `next build`
 * rejects a test file, which only that build catches.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';
import type * as AnnouncementService from '~/server/services/announcement.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as ContentService from '~/server/services/content.service';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as RedisCaches from '~/server/redis/caches';

const h = vi.hoisted(() => ({
  contentSettings: vi.fn(),
  announcements: vi.fn(),
  liveNow: vi.fn(),
  follows: vi.fn(),
  addons: vi.fn(),
  session: vi.fn(),
}));

// The real `~/env/server` validates every prod var and throws under test. Only the deadline
// matters here; the Proxy answers anything else the graph reads at import time. Set small so
// `runAllTimersAsync` reaches it, and non-zero so `withTimeoutFallback` does not pass through.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      SETTINGS_READ_DEADLINE_MS: 20,
      LOGGING: [] as string[],
      // endpoint-helpers spreads this at module load.
      TRPC_ORIGINS: [] as string[],
    } as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
          return 'https://test:test@localhost:5432/test';
        if (
          typeof prop === 'string' &&
          /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
        )
          return 1;
        return undefined;
      },
    }
  ),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: h.session,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserContentSettings: h.contentSettings,
}));
vi.mock('~/server/services/announcement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnouncementService>()),
  getCurrentAnnouncements: h.announcements,
}));
vi.mock('~/server/services/content.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentService>()),
  getTosMeta: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: h.addons,
  getLiveNow: h.liveNow,
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  getUserFollows: h.follows,
}));

import handler from '~/pages/api/user/settings';

const invoke = () => {
  const json = vi.fn();
  const res = { status: vi.fn(() => res), json, setHeader: vi.fn(), end: vi.fn() };
  const req = { method: 'GET', headers: { host: 'civitai.com' }, query: {}, cookies: {} };
  const done = (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(
    req as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { done, json };
};

describe('/api/user/settings read deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.session.mockResolvedValue(null);
    h.contentSettings.mockResolvedValue({ showNsfw: true });
    h.announcements.mockResolvedValue([{ id: 1 }]);
    h.liveNow.mockResolvedValue(true);
    h.follows.mockResolvedValue([7]);
    h.addons.mockResolvedValue([{ id: 'a' }]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('answers normally when every dependency replies', async () => {
    const { done, json } = invoke();
    await vi.runAllTimersAsync();
    await done;

    const body = json.mock.calls[0][0];
    expect(body.settings).toEqual({ showNsfw: true });
    expect(body.announcements).toEqual([{ id: 1 }]);
    expect(body.liveNow).toBe(true);
  });

  it('still answers when a dependency never replies, and seeds the SAFE settings default', async () => {
    // A promise that never settles is the whole point — a `.catch` cannot see it. The
    // assertion is that the handler resolves anyway; fake timers make the deadline fire
    // without the test waiting on a real clock, so a revert fails fast rather than hanging.
    h.contentSettings.mockReturnValue(new Promise(() => undefined));
    const { json } = invoke();
    await vi.runAllTimersAsync();

    // Asserted WITHOUT awaiting the handler: with the deadline removed it never settles, so
    // awaiting it would wedge the runner for the full test timeout instead of reporting.
    // A revert fails here in milliseconds with "spy not called".
    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    // MUST be undefined, not `{}`. AppProvider passes this to `useQuery({ initialData })`
    // under a global `staleTime: Infinity`, so any defined value is pinned for the whole
    // SPA session and never refetched — and an empty one resolves showNsfw off the JWT,
    // which lags a user who just turned nsfw OFF. Seeding `{}` here is a content leak.
    expect(body.settings).toBeUndefined();
    // The rest of the payload still lands — one bad dependency must not degrade the whole
    // response, which is what the outer catch would do.
    expect(body.announcements).toEqual([{ id: 1 }]);
    expect('session' in body).toBe(true);
  });

  it('bounds the authed-only members too', async () => {
    // Every other case runs the anonymous path, where `getUserFollows` is never called and
    // its deadline is unreachable — removing it would pass those tests.
    h.session.mockResolvedValue({ user: { id: 42 } });
    h.follows.mockReturnValue(new Promise(() => undefined));
    h.addons.mockReturnValue(new Promise(() => undefined));
    const { json } = invoke();
    await vi.runAllTimersAsync();

    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.following).toBeUndefined();
    expect(body.browsingSettingsAddons).toBeUndefined();
    // The authed session still lands — a bounded member must not cost the session seed.
    expect(body.session).toEqual({ user: { id: 42 } });
  });

  it('degrades each hanging member independently', async () => {
    h.announcements.mockReturnValue(new Promise(() => undefined));
    h.liveNow.mockReturnValue(new Promise(() => undefined));
    const { json } = invoke();
    await vi.runAllTimersAsync();

    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.announcements).toBeUndefined();
    expect(body.liveNow).toBe(false);
    // The member that did reply is unaffected.
    expect(body.settings).toEqual({ showNsfw: true });
  });
});
