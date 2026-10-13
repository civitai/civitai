import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_PREVIEW_FROM,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { getNavBanners } = await import('~/server/services/nav-banner.service');
const { logToAxiom } = await import('~/server/logging/client');

const TESTER = { id: 10 };
const MOD = { id: 20, isModerator: true };
const PUBLIC_USER = { id: 30 };
const ANON = undefined;

const PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 60 * 60 * 1000);
const DURING = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 24 * 60 * 60 * 1000);
const AFTER = BIRTHDAY_2026_ENDS_AT;

const birthdayIds = async (viewer: Parameters<typeof getNavBanners>[0]['viewer'], now: Date) =>
  (await getNavBanners({ viewer, now })).map((b) => b.id);

beforeEach(() => {
  vi.clearAllMocks();
  testerFlag.reset({ testers: [TESTER.id] });
});

/**
 * The banner follows the event's own access rule, never the client flag: it shows exactly while the
 * viewer can play, so it can never send someone to a page that 404s for them.
 */
describe('the birthday banner, through the real access rule', () => {
  it('shows to testers and moderators in the preview, and to nobody else', async () => {
    expect(await birthdayIds(TESTER, PREVIEW)).toEqual(['event:birthday2026']);
    expect(await birthdayIds(MOD, PREVIEW)).toEqual(['event:birthday2026']);
    expect(await birthdayIds(PUBLIC_USER, PREVIEW)).toEqual([]);
    expect(await birthdayIds(ANON, PREVIEW)).toEqual([]);
  });

  it('shows to everyone, signed out included, once the flag is public and the event open', async () => {
    testerFlag.reset({ public: true });
    for (const viewer of [TESTER, PUBLIC_USER, ANON])
      expect(await birthdayIds(viewer, DURING)).toEqual(['event:birthday2026']);
  });

  // Moderators are on without asking Flipt, so in the preview only the readability check keeps the
  // banner off for them when Flipt cannot be read (the flag could already be armed).
  it('hides from a moderator in the preview when Flipt cannot be read', async () => {
    testerFlag.reset({ readable: false, testers: [TESTER.id] });
    expect(await birthdayIds(MOD, PREVIEW)).toEqual([]);
  });

  it('hides for everyone once the event ends (results are not advertised in v1)', async () => {
    testerFlag.reset({ public: true, testers: [TESTER.id] });
    for (const viewer of [TESTER, MOD, PUBLIC_USER, ANON])
      expect(await birthdayIds(viewer, AFTER)).toEqual([]);
  });

  it('carries the hero image and links to the event page', async () => {
    const [banner] = await getNavBanners({ viewer: TESTER, now: PREVIEW });
    expect(banner).toMatchObject({
      title: 'Civitai turns 4.',
      accent: 'Pick up a hat.',
      href: '/events/birthday2026',
      image: '4a5e404d-ece2-4cca-bbab-cb5a7b0d8d9d',
      dismissible: true,
    });
  });
});

/**
 * The menu entry, the post-editor card and the home block read this promo. It must reach exactly the
 * viewers the strip reaches: anyone else would be shown an event that 404s for them.
 */
describe('the birthday promo, through the real access rule', () => {
  const promos = async (viewer: Parameters<typeof getNavBanners>[0]['viewer'], now: Date) =>
    (await getNavBanners({ viewer, now })).flatMap((b) => (b.promo ? [b.promo] : []));

  it('reaches testers and moderators in the preview, and nobody else', async () => {
    expect((await promos(TESTER, PREVIEW)).map((p) => p.event)).toEqual(['birthday2026']);
    expect((await promos(MOD, PREVIEW)).map((p) => p.event)).toEqual(['birthday2026']);
    expect(await promos(PUBLIC_USER, PREVIEW)).toEqual([]);
    expect(await promos(ANON, PREVIEW)).toEqual([]);
  });

  it('reaches everyone, signed out included, once the flag is public and the event open', async () => {
    testerFlag.reset({ public: true });
    for (const viewer of [TESTER, PUBLIC_USER, ANON])
      expect((await promos(viewer, DURING)).map((p) => p.event)).toEqual(['birthday2026']);
  });

  it('reaches nobody once the event ends', async () => {
    testerFlag.reset({ public: true, testers: [TESTER.id] });
    for (const viewer of [TESTER, MOD, PUBLIC_USER, ANON])
      expect(await promos(viewer, AFTER)).toEqual([]);
  });

  it('carries the menu entry, roster link and editor cards', async () => {
    const [promo] = await promos(TESTER, PREVIEW);
    expect(promo).toEqual({
      event: 'birthday2026',
      menuLabel: "Civitai's 4th Birthday",
      menuIcon: 'confetti',
      teamHref: '/events/birthday2026/team',
      postEditor: {
        title: 'Civitai turns 4.',
        body: 'Put a party hat on an image in this post. Its views and reactions score for your team.',
        draftNote: 'Scores once people can see it.',
        image: '4a5e404d-ece2-4cca-bbab-cb5a7b0d8d9d',
      },
      articleEditor: {
        title: 'Civitai turns 4.',
        body: 'Put a party hat on this article. Its views, reactions and comments score for your team.',
        draftNote: 'Scores once it is published.',
        image: '4a5e404d-ece2-4cca-bbab-cb5a7b0d8d9d',
      },
      modelEditor: {
        title: 'Civitai turns 4.',
        body: 'Put a party hat on this model. Its views and likes score for your team.',
        draftNote: 'Scores once it is published.',
        image: '4a5e404d-ece2-4cca-bbab-cb5a7b0d8d9d',
      },
      homeBlock: {
        eyebrow: "Civitai's 4th Birthday",
        title: 'Civitai turns 4.',
        body: 'Four color teams, Nov 1 to Nov 30. Hat your best work and score for your team.',
        cta: 'See the event',
      },
    });
  });
});

describe('getNavBanners', () => {
  const event = (name: string, extra: object = {}) => ({
    name,
    title: `${name} title`,
    startDate: new Date(0),
    endDate: new Date(8.64e15),
    ...extra,
  });
  const open = vi.fn(async () => 'open' as const);

  it('never asks access for an event without a banner', async () => {
    const result = await getNavBanners({
      viewer: TESTER,
      eventDefs: [event('quiet')],
      getAccess: open,
    });
    expect(result).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('defaults title, image and link from the event, and dismissible to true', async () => {
    const [banner] = await getNavBanners({
      viewer: TESTER,
      eventDefs: [event('e1', { banner: {}, page: { headline: 'Hello', heroImage: 'img-1' } })],
      getAccess: open,
    });
    expect(banner).toEqual({
      id: 'event:e1',
      title: 'Hello',
      accent: undefined,
      text: undefined,
      href: '/events/e1',
      cta: undefined,
      image: 'img-1',
      background: undefined,
      dismissible: true,
      priority: 0,
      promo: {
        event: 'e1',
        menuLabel: 'e1 title',
        menuIcon: 'confetti',
        teamHref: undefined,
        postEditor: undefined,
        homeBlock: undefined,
      },
    });
  });

  it('falls back to the event title, and no image, when the event has no page copy', async () => {
    const [banner] = await getNavBanners({
      viewer: TESTER,
      eventDefs: [event('e1', { banner: {} })],
      getAccess: open,
    });
    expect(banner.title).toBe('e1 title');
    expect(banner.image).toBeUndefined();
  });

  it("lets the banner block override the page's title and image", async () => {
    const [banner] = await getNavBanners({
      viewer: TESTER,
      eventDefs: [
        event('e1', {
          banner: { title: 'Own title', image: 'own-img', dismissible: false },
          page: { headline: 'Hello', heroImage: 'img-1' },
        }),
      ],
      getAccess: open,
    });
    expect(banner).toMatchObject({ title: 'Own title', image: 'own-img', dismissible: false });
  });

  it('serves no promo for an event without a banner', async () => {
    const result = await getNavBanners({
      viewer: TESTER,
      eventDefs: [event('e1', { promo: { menuLabel: 'Menu' } })],
      getAccess: open,
    });
    expect(result).toEqual([]);
  });

  it('links the roster only for an event that is both scored and joinable', async () => {
    const teamHref = async (extra: object) =>
      (
        await getNavBanners({
          viewer: TESTER,
          eventDefs: [event('e1', { banner: {}, ...extra })],
          getAccess: open,
        })
      )[0].promo?.teamHref;
    expect(await teamHref({ scoring: {}, join: {} })).toBe('/events/e1/team');
    expect(await teamHref({ scoring: {} })).toBeUndefined();
    expect(await teamHref({ join: {} })).toBeUndefined();
  });

  it('lets the promo block override the defaults, and fills what it leaves out', async () => {
    const [banner] = await getNavBanners({
      viewer: TESTER,
      eventDefs: [
        event('e1', {
          banner: { image: 'strip-img', text: 'Strip text', cta: 'Strip cta' },
          page: { headline: 'Hello', heroImage: 'img-1' },
          promo: {
            menuLabel: 'Menu',
            menuIcon: 'trophy',
            postEditor: { body: 'Editor body' },
            articleEditor: { body: 'Article body', title: 'Own title', image: 'own-img' },
            modelEditor: { body: 'Model body' },
            homeBlock: { eyebrow: 'Eyebrow' },
          },
        }),
      ],
      getAccess: open,
    });
    expect(banner.promo).toEqual({
      event: 'e1',
      menuLabel: 'Menu',
      menuIcon: 'trophy',
      teamHref: undefined,
      postEditor: { title: 'Hello', body: 'Editor body', image: 'strip-img' },
      articleEditor: { title: 'Own title', body: 'Article body', image: 'own-img' },
      modelEditor: { title: 'Hello', body: 'Model body', image: 'strip-img' },
      homeBlock: { eyebrow: 'Eyebrow', title: 'Hello', body: 'Strip text', cta: 'Strip cta' },
    });
  });

  it('orders by priority, highest first', async () => {
    const result = await getNavBanners({
      viewer: TESTER,
      eventDefs: [
        event('low', { banner: { priority: 1 } }),
        event('high', { banner: { priority: 5 } }),
      ],
      getAccess: open,
    });
    expect(result.map((b) => b.id)).toEqual(['event:high', 'event:low']);
  });

  it('drops an event whose access check throws, and keeps the others', async () => {
    const result = await getNavBanners({
      viewer: TESTER,
      eventDefs: [event('broken', { banner: {} }), event('fine', { banner: {} })],
      getAccess: async (e) => {
        if (e.name === 'broken') throw new Error('flag has no Flipt key');
        return 'open';
      },
    });
    expect(result.map((b) => b.id)).toEqual(['event:fine']);
    // Fails closed, but not silently.
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logToAxiom).mock.calls[0][0]).toMatchObject({
      name: 'nav-banner',
      event: 'broken',
      message: 'flag has no Flipt key',
    });
  });
});
