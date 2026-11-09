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

const { resolveSettingsBootstrapSeeds } = await import(
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
    const seeds = await resolveSettingsBootstrapSeeds(req, session);

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
    await resolveSettingsBootstrapSeeds(req, session);
    await resolveSettingsBootstrapSeeds(req, session);
    expect(h.getEventCosmetic).toHaveBeenCalledTimes(2);
  });
});
