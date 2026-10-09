import { describe, expect, it } from 'vitest';
import {
  MAX_EVENT_STRIPS,
  visibleNavBanners,
} from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import {
  addNavBannerDismissed,
  NAV_BANNERS_DISMISSED_MAX,
  parseNavBannersDismissed,
} from '~/shared/constants/nav-banner.constants';

const banner = (id: string, extra: Partial<NavBanner> = {}): NavBanner => ({
  id,
  title: id,
  href: `/events/${id}`,
  dismissible: true,
  priority: 0,
  ...extra,
});

describe('visibleNavBanners', () => {
  it('hides a dismissed banner', () => {
    expect(visibleNavBanners([banner('a')], ['a'])).toEqual([]);
  });

  it('ignores a dismissal for a banner that is not dismissible', () => {
    expect(
      visibleNavBanners([banner('a', { dismissible: false })], ['a']).map((b) => b.id)
    ).toEqual(['a']);
  });

  it('falls through to the next banner when the first is dismissed', () => {
    expect(visibleNavBanners([banner('a'), banner('b')], ['a']).map((b) => b.id)).toEqual(['b']);
  });

  // Decision (lead, 2026-10-09): the slot stacks at most two strips, Buzz Bonus first. The Buzz
  // Bonus loads on the client, so if the event-strip count depended on it, the strips would reflow
  // after the first paint. One event strip, always, keeps the cap without that dependency. Raising
  // this cap needs the Buzz Bonus seeded on the server first.
  it('shows one event strip at most, so the Buzz Bonus can never reflow it', () => {
    expect(MAX_EVENT_STRIPS).toBe(1);
    expect(visibleNavBanners([banner('a'), banner('b')], []).map((b) => b.id)).toEqual(['a']);
  });
});

describe('the dismissed cookie', () => {
  it('round-trips through JSON', () => {
    expect(parseNavBannersDismissed(JSON.stringify(['event:a', 'event:b']))).toEqual([
      'event:a',
      'event:b',
    ]);
  });

  it.each([undefined, '', 'not json', '{"a":1}', '[1,2]'])(
    'reads %j as nothing dismissed',
    (raw) => {
      expect(parseNavBannersDismissed(raw)).toEqual([]);
    }
  );

  it('keeps only the newest ids, so the cookie cannot grow without bound', () => {
    let ids: string[] = [];
    for (let i = 0; i < NAV_BANNERS_DISMISSED_MAX + 5; i++)
      ids = addNavBannerDismissed(ids, `e${i}`);
    expect(ids).toHaveLength(NAV_BANNERS_DISMISSED_MAX);
    expect(ids.at(-1)).toBe(`e${NAV_BANNERS_DISMISSED_MAX + 4}`);
    expect(ids[0]).toBe('e5');
  });

  it('does not repeat an id dismissed twice', () => {
    expect(addNavBannerDismissed(['a', 'b'], 'a')).toEqual(['b', 'a']);
  });
});
