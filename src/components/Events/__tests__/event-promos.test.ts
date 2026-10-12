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
const {
  dismissHint,
  eventMenuEntries,
  eventPromosFrom,
  hatButtonLabel,
  editorCardId,
  editorPromo,
  teamRosterHref,
} = await import('~/components/Events/event-promos');
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
      postEditor: editorPromo(promos, [], 'postEditor')?.event,
      editorCopy: !!editorPromo(promos, [], 'postEditor')?.postEditor?.body,
      articleEditor: !!editorPromo(promos, [], 'articleEditor')?.articleEditor?.body,
      modelEditor: !!editorPromo(promos, [], 'modelEditor')?.modelEditor?.body,
    };
  };

  it('shows nothing to a signed-in viewer without the flag, or a signed-out one, in the preview', async () => {
    for (const viewer of [PUBLIC_USER, ANON])
      expect(await surfaces(viewer)).toEqual({
        menu: [],
        roster: undefined,
        hints: [],
        postEditor: undefined,
        editorCopy: false,
        articleEditor: false,
        modelEditor: false,
      });
  });

  it('shows the menu entry, roster link and dismiss hint to a tester in the preview', async () => {
    expect(await surfaces(TESTER)).toEqual({
      menu: ['/events/birthday2026'],
      roster: '/events/birthday2026/team',
      hints: ["Find Civitai's 4th Birthday in your menu any time."],
      postEditor: 'birthday2026',
      editorCopy: true,
      articleEditor: true,
      modelEditor: true,
    });
  });

  it('shows nothing once the event ends', async () => {
    testerFlag.reset({ public: true, testers: [TESTER.id] });
    expect(await surfaces(TESTER, BIRTHDAY_2026_ENDS_AT)).toEqual({
      menu: [],
      roster: undefined,
      hints: [],
      postEditor: undefined,
      editorCopy: false,
      articleEditor: false,
      modelEditor: false,
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

describe('editorPromo', () => {
  const editor = { title: 'T', body: 'B' };

  it('is the first event with editor copy that the viewer has not hidden', () => {
    const promos = [
      promo('a'),
      promo('b', { postEditor: editor }),
      promo('c', { postEditor: editor }),
    ];
    expect(editorPromo(promos, [], 'postEditor')?.event).toBe('b');
    expect(editorPromo(promos, [editorCardId('postEditor', 'b')], 'postEditor')?.event).toBe('c');
    expect(editorPromo([promo('a')], [], 'postEditor')).toBeUndefined();
  });

  it("is not hidden by dismissing the event's strip", () => {
    expect(
      editorPromo([promo('b', { postEditor: editor })], ['event:b'], 'postEditor')?.event
    ).toBe('b');
  });

  it("reads each editor's own copy and is hidden per editor", () => {
    const promos = [
      promo('a', { postEditor: editor }),
      promo('b', { articleEditor: editor }),
      promo('c', { postEditor: editor, articleEditor: editor }),
    ];
    expect(editorPromo(promos, [], 'articleEditor')?.event).toBe('b');
    const hidden = [editorCardId('articleEditor', 'b'), editorCardId('articleEditor', 'c')];
    expect(editorPromo(promos, hidden, 'articleEditor')).toBeUndefined();
    expect(editorPromo(promos, hidden, 'postEditor')?.event).toBe('a');
    // The post editor's id predates the article card: changing it would bring back hidden cards.
    expect(editorCardId('postEditor', 'a')).toBe('post-editor:event:a');
    expect(editorCardId('articleEditor', 'a')).toBe('article-editor:event:a');
    expect(editorCardId('modelEditor', 'a')).toBe('model-editor:event:a');
    expect(editorPromo(promos, [], 'modelEditor')).toBeUndefined();
    expect(editorPromo([promo('m', { modelEditor: editor })], [], 'modelEditor')?.event).toBe('m');
  });
});

describe('hatButtonLabel', () => {
  it('names the decoration for an event whose hats sit on images, and nothing otherwise', () => {
    expect(hatButtonLabel('birthday2026')).toBe('Put on a Party Hat');
    expect(hatButtonLabel('no-such-event')).toBeUndefined();
  });

  it('checks the kind of content the hat would go on', () => {
    expect(hatButtonLabel('birthday2026', 'Article')).toBe('Put on a Party Hat');
    expect(hatButtonLabel('birthday2026', 'Post')).toBeUndefined();
  });
});
