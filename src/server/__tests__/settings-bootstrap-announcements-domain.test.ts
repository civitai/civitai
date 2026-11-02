/**
 * The SSR announcements seed is resolved for the domain of the host the VIEWER addressed — the
 * same domain the browser's own `announcement.getAnnouncements` call resolves (its
 * `applyRequestDomainColor` middleware reads that request's host). The seed lands under the
 * client's per-domain query key and is kept fresh for minutes, so a seed for any other domain is
 * a different answer under the same key.
 *
 * A server render reads the bootstrap in-process with the INTERNAL bootstrap host (see
 * `bootstrapHost`), which maps to no domain: before this, every render seeded the all-domains
 * list, so a domain-specific announcement never reached the first paint and the seed and the
 * live call read two cache entries that went stale independently.
 *
 * The ToS member keeps the internal host on purpose (a separate product question), pinned below
 * so this change stays scoped to announcements.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';
import type * as AnnouncementService from '~/server/services/announcement.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as ContentService from '~/server/services/content.service';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as RedisCaches from '~/server/redis/caches';
import type * as SiteAlertService from '~/server/services/site-alert.service';

const h = vi.hoisted(() => {
  // Read by `~/server/utils/server-domain` when it loads, so set before any import runs.
  vi.stubEnv('SERVER_DOMAIN_GREEN', 'green.test');
  vi.stubEnv('SERVER_DOMAIN_BLUE', 'blue.test');
  vi.stubEnv('SERVER_DOMAIN_RED', 'red.test');
  vi.stubEnv('NEXTAUTH_URL_INTERNAL', 'http://bootstrap.internal:3000');
  return {
    announcements: vi.fn(async (_: { domain?: string; userId?: number }) => [] as unknown[]),
    tos: vi.fn(async (_: { domainColor: string }) => ({} as unknown)),
    session: vi.fn(async () => null as unknown),
  };
});

vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      SETTINGS_READ_DEADLINE_MS: 5_000,
      LOGGING: [] as string[],
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
vi.mock('~/server/services/announcement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnouncementService>()),
  getCurrentAnnouncements: h.announcements,
}));
vi.mock('~/server/services/content.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentService>()),
  getTosMeta: h.tos,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserContentSettings: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/nav-banner.service', () => ({ getNavBanners: vi.fn(async () => []) }));
vi.mock('~/server/services/site-alert.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SiteAlertService>()),
  getActiveSiteAlerts: vi.fn(async () => ({ version: 2, alerts: [] })),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: vi.fn(async () => []),
  getLiveNow: vi.fn(async () => false),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  getUserFollows: vi.fn(async () => []),
}));

import handler from '~/pages/api/user/settings';
import { resolveSettingsBootstrapForRender } from '~/server/services/settings-bootstrap.service';

const render = (host: string) =>
  resolveSettingsBootstrapForRender({ headers: { host }, cookies: {}, url: '/models' } as never);

const seededDomain = () => h.announcements.mock.calls.map(([args]) => args.domain);

beforeEach(() => {
  h.session.mockResolvedValue(null);
});
afterEach(() => {
  vi.clearAllMocks();
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('the SSR announcements seed resolves the viewer’s domain', () => {
  it.each([
    ['blue.test', 'blue'],
    ['green.test', 'green'],
    ['red.test', 'red'],
  ])('a render on %s seeds the %s announcements', async (host, domain) => {
    await render(host);
    expect(seededDomain()).toEqual([domain]);
  });

  it('a render on a host that maps to no domain seeds the all-domains list', async () => {
    await render('unknown.test');
    expect(seededDomain()).toEqual([undefined]);
  });

  it('the HTTP route resolves the host it was called on, as before', async () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => res), json, setHeader: vi.fn(), end: vi.fn() };
    await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(
      { method: 'GET', headers: { host: 'green.test' }, query: {}, cookies: {} } as never,
      res as never
    );
    expect(json).toHaveBeenCalled();
    expect(seededDomain()).toEqual(['green']);
  });

  it('control: the ToS member still reads the internal bootstrap host (its blue fallback)', async () => {
    await render('green.test');
    expect(h.tos.mock.calls.map(([args]) => args.domainColor)).toEqual(['blue']);
    // ...while the announcements seed, in the same render, is green's.
    expect(seededDomain()).toEqual(['green']);
  });
});
