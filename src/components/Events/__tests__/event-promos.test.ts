import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_PREVIEW_FROM,
} from '~/shared/constants/birthday2026.constants';
import type { EventPromo, NavBanner } from '~/shared/constants/nav-banner.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { getNavBanners } = await import('~/server/services/nav-banner.service');
const { dismissHint, eventMenuEntries, eventPromosFrom, teamRosterHref } = await import(
  '~/components/Events/event-promos'
);
const { visibleNavBanners } = await import(
  '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed'
);

const TESTER = { id: 10 };
const PUBLIC_USER = { id: 30 };
const ANON = undefined;
const PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 60 * 60 * 1000);

beforeEach(() => {
  testerFlag.reset({ testers: [TESTER.id] });
});

/**
 * Each surface below is fed the answer the real access rule gives this viewer, the same answer the
 * settings bootstrap seeds. A surface that read anything else (an event constant, a date check)
 * would show the event to viewers the rule refuses.
 */
describe('event entry points, from the gated answer', () => {
  const surfaces = async (viewer: { id: number } | undefined, now = PREVIEW) => {
    const banners = await getNavBanners({ viewer, now });
    const promos = eventPromosFrom(banners);
    return {
      menu: eventMenuEntries(promos).map((e) => e.href),
      roster: teamRosterHref(promos, 'birthday2026'),
      hints: banners.map((b) => dismissHint(b, banners)).filter(Boolean),
    };
  };

  it('shows nothing to a signed-in viewer without the flag, or a signed-out one, in the preview', async () => {
    for (const viewer of [PUBLIC_USER, ANON])
      expect(await surfaces(viewer)).toEqual({ menu: [], roster: undefined, hints: [] });
  });

  it('shows the menu entry, roster link and dismiss hint to a tester in the preview', async () => {
    expect(await surfaces(TESTER)).toEqual({
      menu: ['/events/birthday2026'],
      roster: '/events/birthday2026/team',
      hints: ["Find Civitai's 4th Birthday in your menu any time."],
    });
  });

  it('shows nothing once the event ends', async () => {
    testerFlag.reset({ public: true, testers: [TESTER.id] });
    expect(await surfaces(TESTER, BIRTHDAY_2026_ENDS_AT)).toEqual({
      menu: [],
      roster: undefined,
      hints: [],
    });
  });
});

const promo = (event: string, extra: Partial<EventPromo> = {}): EventPromo => ({
  event,
  menuLabel: `${event} label`,
  menuIcon: 'confetti',
  ...extra,
});
const banner = (event: string, extra: Partial<NavBanner> = {}): NavBanner => ({
  id: `event:${event}`,
  title: event,
  href: `/events/${event}`,
  dismissible: true,
  priority: 0,
  promo: promo(event),
  ...extra,
});

describe('eventPromosFrom', () => {
  it('keeps a dismissed event, which the strip drops', () => {
    const banners = [banner('e1')];
    expect(visibleNavBanners(banners, ['event:e1'])).toEqual([]);
    expect(eventPromosFrom(banners).map((p) => p.event)).toEqual(['e1']);
  });

  it('skips an entry from a server that predates the promo', () => {
    expect(eventPromosFrom([banner('e1', { promo: undefined })])).toEqual([]);
    expect(eventPromosFrom(undefined)).toEqual([]);
  });
});

describe('eventMenuEntries', () => {
  it('lists at most two events, in the order given', () => {
    const entries = eventMenuEntries([promo('a'), promo('b'), promo('c')]);
    expect(entries.map((e) => [e.label, e.href])).toEqual([
      ['a label', '/events/a'],
      ['b label', '/events/b'],
    ]);
  });
});

describe('dismissHint', () => {
  it('points to the menu only for an event the menu lists', () => {
    const banners = ['a', 'b', 'c'].map((e) => banner(e));
    expect(banners.map((b) => dismissHint(b, banners))).toEqual([
      'Find a label in your menu any time.',
      'Find b label in your menu any time.',
      undefined,
    ]);
    expect(dismissHint(banner('d', { promo: undefined }), banners)).toBeUndefined();
  });
});

describe('teamRosterHref', () => {
  it("is the named event's roster link, and nothing for an event without one", () => {
    const promos = [promo('a', { teamHref: '/events/a/team' }), promo('b')];
    expect(teamRosterHref(promos, 'a')).toBe('/events/a/team');
    expect(teamRosterHref(promos, 'b')).toBeUndefined();
    expect(teamRosterHref(promos, 'c')).toBeUndefined();
  });
});
