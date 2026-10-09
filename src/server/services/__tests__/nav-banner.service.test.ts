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
    });
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
  });
});
