import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import type * as AnnouncementService from '~/server/services/announcement.service';
import type * as ContentService from '~/server/services/content.service';
import type * as RedisCaches from '~/server/redis/caches';
import type * as SiteAlertService from '~/server/services/site-alert.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserService from '~/server/services/user.service';
import {
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * Two bootstrap members read the viewer's event cosmetic: the nav banners (whether the viewer
 * joined, for the joined cta) and the event seeds (`event.getCosmetic`). Both run in the same
 * `Promise.all`, so on a cache miss each would read the database and write the same cache entry.
 * Pinned: ONE read per (user, event) per bootstrap, and both members still get its answer.
 *
 * Here the real nav-banner and event-seeds services run; only the cosmetic and access reads
 * underneath them, Flipt and the other members' sources are stubbed.
 */

vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const h = vi.hoisted(() => ({
  getEventCosmetic: vi.fn(),
  getViewerEventAccess: vi.fn(async () => 'open' as const),
}));
// Wholesale: the reads under test, and the real module pulls in the whole event engine's I/O.
vi.mock('~/server/services/event.service', () => h);
// The bearer lookup: what getServerAuthSession records on the request it was given.
const bearer = vi.hoisted(() => ({ result: null as Record<string, unknown> | null }));
const hub = vi.hoisted(() => ({ result: null as Record<string, unknown> | null }));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => bearer.result),
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => hub.result),
  maybeRollHubCookie: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserContentSettings: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/content.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentService>()),
  getTosMeta: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/announcement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnouncementService>()),
  getCurrentAnnouncements: vi.fn(async () => []),
}));
vi.mock('~/server/services/site-alert.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SiteAlertService>()),
  getActiveSiteAlerts: vi.fn(async () => ({ version: 1, alerts: [] })),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  getUserFollows: vi.fn(async () => []),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: vi.fn(async () => []),
  getLiveNow: vi.fn(async () => false),
}));

const { resolveSettingsBootstrap, resolveSettingsBootstrapSeeds } = await import(
  '~/server/services/settings-bootstrap.service'
);

type Session = Parameters<typeof resolveSettingsBootstrapSeeds>[1];
const USER_ID = 42;
const session = { user: { id: USER_ID, username: 'player' } } as unknown as Session;
const req = { headers: { host: 'civitai.com' }, cookies: {}, url: '/' } as unknown as Parameters<
  typeof resolveSettingsBootstrapSeeds
>[0];
const COSMETIC = { available: true, obtained: true, equipped: true, data: {}, cosmetic: null };
// While the event runs, so its banner shows and its decoration is released.
const DURING = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: DURING });
  testerFlag.reset({ public: true });
  h.getEventCosmetic.mockReset().mockResolvedValue(COSMETIC);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('settings bootstrap: the event cosmetic is read once per request', () => {
  it('reads it once for the nav banners and the event seeds together', async () => {
    const seeds = await resolveSettingsBootstrapSeeds(req, session, {});

    // Both members consumed the read: the banner shows its joined cta and the seed carries it.
    // Without these, a single call could mean one member simply stopped reading.
    const banner = seeds.navBanners?.find((b) => b.id === `event:${BIRTHDAY_2026_EVENT}`);
    expect(banner?.cta).toBe('See the standings');
    expect(seeds.eventSeeds).toEqual([
      { event: BIRTHDAY_2026_EVENT, access: 'open', cosmetic: COSMETIC },
    ]);

    const reads = h.getEventCosmetic.mock.calls.filter(
      ([args]) => args.event === BIRTHDAY_2026_EVENT && args.user.id === USER_ID
    );
    expect(reads).toHaveLength(1);
  });

  it('does not share a read across requests', async () => {
    await resolveSettingsBootstrapSeeds(req, session, {});
    await resolveSettingsBootstrapSeeds(req, session, {});
    expect(h.getEventCosmetic).toHaveBeenCalledTimes(2);
  });
});

describe('settings bootstrap: event visibility follows the request credential', () => {
  const moderator = {
    user: { id: USER_ID, username: 'mod', isModerator: true },
  } as unknown as Session;
  const scopedKey = {
    apiKeyId: 7,
    apiKeyType: ApiKeyType.User,
    subject: { type: 'apiKey' as const, id: 7 },
    tokenScope: TokenScope.UserRead,
  };
  const bannerShown = (seeds: Awaited<ReturnType<typeof resolveSettingsBootstrapSeeds>>) =>
    !!seeds.navBanners?.some((b) => b.id === `event:${BIRTHDAY_2026_EVENT}`);
  const seededViewers = () =>
    (h.getViewerEventAccess.mock.calls as unknown[][]).map(
      ([args]) => (args as { viewer?: unknown }).viewer
    );

  beforeEach(() => {
    // Launched for nobody: only the flag's moderator shortcut lets anyone in.
    testerFlag.reset({ public: false });
    h.getViewerEventAccess.mockClear();
  });

  it('shows a moderator on a session the unlaunched event', async () => {
    expect(bannerShown(await resolveSettingsBootstrapSeeds(req, moderator, {}))).toBe(true);
    expect(seededViewers()).toContainEqual(expect.objectContaining({ isModerator: true }));
  });

  it('reads a moderator with no known credential as the user alone', async () => {
    expect(bannerShown(await resolveSettingsBootstrapSeeds(req, moderator, null))).toBe(false);
    expect(seededViewers().length).toBeGreaterThan(0);
    for (const viewer of seededViewers())
      expect(viewer).toEqual(expect.objectContaining({ isModerator: false }));
  });

  it('reads a moderator on a scoped key as the user alone', async () => {
    expect(bannerShown(await resolveSettingsBootstrapSeeds(req, moderator, scopedKey))).toBe(false);
    expect(seededViewers().length).toBeGreaterThan(0);
    for (const viewer of seededViewers())
      expect(viewer).toEqual(expect.objectContaining({ isModerator: false }));
  });
});

describe('settings bootstrap: the credential comes from the session lookup', () => {
  const moderatorUser = { id: USER_ID, username: 'mod', isModerator: true };
  const bootstrapFor = (credential: Record<string, unknown> | 'session') => {
    bearer.result = credential === 'session' ? null : { user: moderatorUser, ...credential };
    hub.result = credential === 'session' ? { user: moderatorUser } : null;
    return resolveSettingsBootstrap({
      req: {
        headers: {
          host: 'civitai.com',
          ...(credential === 'session' ? {} : { authorization: 'Bearer key' }),
        },
        cookies: {},
        url: '/api/user/settings',
      },
      res: { setHeader: () => undefined, getHeader: () => undefined },
    } as unknown as Parameters<typeof resolveSettingsBootstrap>[0]);
  };
  const viewers = () =>
    (h.getViewerEventAccess.mock.calls as unknown[][]).map(
      ([args]) => (args as { viewer?: unknown }).viewer
    );

  beforeEach(() => {
    testerFlag.reset({ public: false });
    h.getViewerEventAccess.mockClear();
  });

  it('reads a moderator on a scoped key as the user alone', async () => {
    const seeds = await bootstrapFor({
      tokenScope: TokenScope.UserRead,
      apiKeyId: 7,
      apiKeyType: ApiKeyType.User,
      subject: { type: 'apiKey', id: 7 },
    });
    expect(seeds.navBanners?.some((b) => b.id === `event:${BIRTHDAY_2026_EVENT}`)).toBe(false);
    expect(viewers().length).toBeGreaterThan(0);
    for (const viewer of viewers()) expect(viewer).toMatchObject({ isModerator: false });
  });

  it('keeps a moderator on a session', async () => {
    const seeds = await bootstrapFor('session');
    expect(seeds.navBanners?.some((b) => b.id === `event:${BIRTHDAY_2026_EVENT}`)).toBe(true);
    expect(viewers()).toContainEqual(expect.objectContaining({ isModerator: true }));
  });

  it('keeps a moderator on a full-access personal key', async () => {
    const seeds = await bootstrapFor({
      tokenScope: TokenScope.Full,
      apiKeyId: 8,
      apiKeyType: ApiKeyType.User,
      subject: { type: 'apiKey', id: 8 },
    });
    expect(seeds.navBanners?.some((b) => b.id === `event:${BIRTHDAY_2026_EVENT}`)).toBe(true);
    expect(viewers()).toContainEqual(expect.objectContaining({ isModerator: true }));
  });
});
