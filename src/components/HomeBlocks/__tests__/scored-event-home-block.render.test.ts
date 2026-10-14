// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Each stands in for one of the event's own gated answers to this viewer.
const h = vi.hoisted(() => ({
  user: null as { id: number } | null,
  banners: [] as NavBanner[],
  cosmetic: undefined as unknown,
  standings: undefined as unknown,
  hats: [] as unknown[],
  eventData: undefined as unknown,
  dismissed: [] as string[],
  inView: true,
  cosmeticLoading: false,
  getDataEnabled: [] as unknown[],
  join: vi.fn(async () => undefined),
  trigger: vi.fn(),
  teamsLive: [] as unknown[][],
  hatsLive: [] as { topicIds: string[]; inView: boolean }[],
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getNavBanners': { useQuery: () => ({ data: h.banners }) },
    'event.getCosmetic': {
      useQuery: (_i: unknown, o?: { enabled?: boolean }) => ({
        data: o?.enabled && !h.cosmeticLoading ? h.cosmetic : undefined,
        isInitialLoading: !!o?.enabled && h.cosmeticLoading,
      }),
    },
    'event.getStandings': { useQuery: () => ({ data: h.standings }) },
    'event.getMyHats': {
      useQuery: (_i: unknown, o?: { enabled?: boolean }) => ({
        data: o?.enabled ? h.hats : undefined,
      }),
    },
    'event.getData': {
      useQuery: (_i: unknown, o?: { enabled?: boolean }) => {
        h.getDataEnabled.push(o?.enabled);
        return { data: o?.enabled ? h.eventData : undefined };
      },
    },
    'event.activateCosmetic': {
      useMutation: () => ({ mutateAsync: h.join, isPending: false }),
    },
  }),
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCurrentUser: () => h.user,
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => {
  const actual = await importOriginal<{ dialogStore: object }>();
  return { ...actual, dialogStore: { ...actual.dialogStore, trigger: h.trigger } };
});
// The real one wraps a sign-in redirect that needs a router; the click is what is measured here.
vi.mock('~/components/Events/ScoredEvent/JoinEventButton', () => ({
  JoinEventButton: ({ onClick }: { onClick: () => void }) =>
    React.createElement('button', { onClick }, 'Join and get your free hat'),
}));
// Media and the feed-card thumb need the CDN and image guard; their src is what matters here.
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  EdgeMedia: ({ src, alt, className }: { src: string; alt?: string; className?: string }) =>
    React.createElement('img', { 'data-src': src, alt, className }),
}));
// Formats as the real one does, without its digit columns, so the text reads as on screen.
vi.mock('~/components/Metrics/AnimatedCount', () => ({
  AnimatedCount: ({ value, abbreviate = true }: { value: number; abbreviate?: boolean }) =>
    React.createElement(
      'span',
      null,
      new Intl.NumberFormat(
        'en-US',
        abbreviate ? { notation: 'compact', maximumFractionDigits: 1 } : {}
      ).format(value)
    ),
}));
// The live pushes need the signals connection; what the block asks them to follow is measured here.
vi.mock('~/components/Events/ScoredEvent/event-points-live', () => ({
  useEventTeamsLivePoints: (...args: unknown[]) => {
    h.teamsLive.push(args);
  },
  MyHatsLivePoints: (props: { topicIds: string[]; inView: boolean }) => {
    h.hatsLive.push(props);
    return null;
  },
}));
vi.mock('~/components/Events/ScoredEvent/EventContentThumb', () => ({
  EventContentThumb: ({ hat }: { hat: { url: string } }) =>
    React.createElement('div', { 'data-testid': 'thumb', 'data-hat': hat.url }),
}));
vi.mock('~/components/HomeBlocks/HomeBlockWrapper', () => ({
  HomeBlockWrapper: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));
vi.mock('~/hooks/useInView', () => ({
  useInView: () => ({ ref: () => undefined, inView: h.inView }),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMaybeAppContext: () => ({ navBannersDismissed: h.dismissed }),
}));
vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setCookie: vi.fn(),
}));

const { setCookie } = await import('cookies-next');
const { HAT_ALLOWANCE } = await import(
  '~/components/Cosmetics/EventDecoration/event-decoration-placement'
);
const { ScoredEventHomeBlock } = await import('~/components/HomeBlocks/ScoredEventHomeBlock');
const { EventHomeBlock } = await import('~/components/HomeBlocks/EventHomeBlock');
const PlaceHatModal = (await import('~/components/Events/ScoredEvent/PlaceHatModal')).default;
const EventVideoModal = (await import('~/components/Events/ScoredEvent/EventVideoModal')).default;

const NOW = new Date('2026-11-10T00:00:00Z');
const data = {
  title: "Civitai's 4th Birthday",
  startDate: new Date('2026-11-01T00:00:00Z'),
  endDate: new Date('2026-12-01T00:00:00Z'),
  finalAt: new Date('2026-12-02T00:00:00Z'),
  preview: false,
  joinable: true,
  scored: true,
  teams: ['Blue', 'Pink'],
  page: {
    headline: 'Civitai turns 4.',
    headlineAccent: 'Pick up a hat.',
    heroImage: 'hero-id',
    heroVideo: { id: 'film', title: 'Hats On', duration: 42.4 },
    prize: { title: 'Champion badge', body: 'For the winners.' },
    prizeBadge: { Blue: { animated: 'blue-anim', static: 'blue-static' } },
  },
} as unknown as React.ComponentProps<typeof ScoredEventHomeBlock>['data'];
const BANNER: NavBanner = {
  id: 'event:birthday2026',
  title: 'Civitai turns 4.',
  href: '/events/birthday2026',
  dismissible: true,
  priority: 0,
  promo: {
    event: 'birthday2026',
    menuLabel: "Civitai's 4th Birthday",
    menuIcon: 'confetti',
    homeBlock: {
      eyebrow: "Civitai's 4th Birthday",
      title: 'Civitai turns 4.',
      body: 'Four colour teams.',
    },
  },
};
const STANDINGS = {
  updatedAt: NOW,
  teams: [
    { team: 'Blue', rank: 1, score: 1200 },
    { team: 'Pink', rank: 2, score: 800 },
  ],
  teamHats: [
    { team: 'Blue', url: 'cap-blue' },
    { team: 'Pink', url: 'cap-pink' },
  ],
};
const placed = (n: number, points: number) => ({
  cosmeticId: n,
  claimKey: 'k',
  topicId: `topic-${n}`,
  name: `Hat ${n}`,
  points,
  data: { url: `hat-${n}` },
  placedOn: { entityType: 'Image', entityId: 100 + n, image: { id: 100 + n } },
});
const unplaced = (n: number) => ({ ...placed(n, 0), placedOn: null });

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
const onClose = vi.fn();
const onExpand = vi.fn();
beforeEach(() => {
  h.user = null;
  h.banners = [BANNER];
  h.cosmetic = undefined;
  h.standings = STANDINGS;
  h.hats = [];
  h.eventData = data;
  h.dismissed = [];
  h.inView = true;
  h.cosmeticLoading = false;
  h.getDataEnabled = [];
  h.teamsLive = [];
  h.hatsLive = [];
  vi.mocked(setCookie).mockClear();
  h.join.mockClear();
  h.trigger.mockClear();
  onClose.mockClear();
  onExpand.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
});

function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, node)));
  return host;
}
const block = (collapsed = false, eventData = data) =>
  mount(
    React.createElement(ScoredEventHomeBlock, {
      event: 'birthday2026',
      data: eventData,
      collapsed,
      onClose,
      onExpand,
    })
  );
const text = (el: Element | null) => el?.textContent ?? '';
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => text(b).includes(label));
const hrefs = (el: HTMLElement) => [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
const srcs = (el: Element | null) =>
  [...(el?.querySelectorAll('img') ?? [])].map((i) => i.getAttribute('data-src'));
const joinAs = (team: string) => {
  h.user = { id: 1 };
  h.cosmetic = { obtained: true, cosmetic: { data: { team } } };
};

describe('not joined', () => {
  it('shows the headline, the team caps and Join, and no standings', () => {
    const el = block();
    expect(text(el)).toContain('Civitai turns 4. Pick up a hat.');
    expect(text(el)).toContain('Four colour teams.');
    expect(srcs(el.querySelector('[data-testid="event-home-block-caps"]'))).toEqual([
      'cap-blue',
      'cap-pink',
    ]);
    expect(el.querySelector('[data-testid="event-home-block-standings"]')).toBeNull();
    // Shows no standings, so follows no team totals.
    expect(h.teamsLive.at(-1)?.[2]).toBe(false);
    act(() => button(el, 'Join and get your free hat')!.click());
    expect(h.join).toHaveBeenCalledWith({ event: 'birthday2026' });
  });

  // To whoever lets the accent flow inline again: it wrapped as "Civitai turns 4. Pick / up a hat."
  // on desktop. Justin asked for the break after the title, always, and the accent unbroken
  // (2026-10-14).
  it('puts the accent on its own line and never breaks it', () => {
    const accent = [...block().querySelectorAll('span')].find((s) => text(s) === 'Pick up a hat.')!;
    expect(accent.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['block', 'whitespace-nowrap', 'w-fit'])
    );
  });

  it('plays the film with a join offer under it', () => {
    const el = block();
    const play = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Watch the Hats On video"]'
    )!;
    expect(text(play)).toContain('Watch · 0:42');
    act(() => play.click());
    const [[arg]] = h.trigger.mock.calls as [[{ component: unknown; props: { onJoin?: unknown } }]];
    expect(arg.component).toBe(EventVideoModal);
    expect(arg.props.onJoin).toBeTypeOf('function');
  });

  // To whoever moves it to a corner again: Justin preferred it centered on the art (2026-10-13),
  // made see-through so the art still shows behind it.
  it('centers the film button on the art, see-through', () => {
    const play = block().querySelector('button[aria-label="Watch the Hats On video"]')!;
    const classes = play.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(['left-1/2', 'top-1/2', '-translate-x-1/2', '-translate-y-1/2'])
    );
    expect(classes.filter((c) => /^(left|right|top|bottom)-/.test(c))).toEqual([
      'left-1/2',
      'top-1/2',
    ]);
    const disc = play.firstElementChild!.className.split(/\s+/);
    const fill = disc.filter((c) => c.startsWith('bg-'));
    expect(fill).toEqual(['bg-white/30']);
    expect(disc).toContain('backdrop-blur-md');
  });
});

describe('joined', () => {
  it('shows your team, the standings with yours lit, and your hat with its points', () => {
    joinAs('Pink');
    h.hats = [placed(1, 512)];
    const el = block();
    expect(text(el)).toContain("You're onTeam Pink");
    expect(button(el, 'Join')).toBeUndefined();
    const mine = el.querySelector('[data-testid="event-home-block-standings"] [data-mine]');
    expect(text(mine)).toContain('Pink');
    expect(text(el)).toContain('512 points');
    const tiles = el.querySelectorAll('[data-testid="event-home-block-hat"]');
    expect(tiles).toHaveLength(1);
    expect(text(tiles[0])).toContain('+512');
    // The tile truncates the name; the full name is on hover.
    expect(tiles[0].querySelector('[title]')?.getAttribute('title')).toBe('Hat 1');
    expect(el.querySelector('[data-testid="event-home-block-get-hat"]')?.getAttribute('href')).toBe(
      '/events/birthday2026#team-hats'
    );
  });

  // To whoever puts the longer copy back: "Get another hat / One more post scoring" wrapped to four
  // lines in the 104px tile. Justin chose this hat-tile layout, two short unbroken lines (2026-10-14).
  it('lays the get-a-hat tile out like a hat tile, in two lines that do not wrap', () => {
    joinAs('Pink');
    h.hats = [placed(1, 512)];
    const tile = block().querySelector('[data-testid="event-home-block-get-hat"]')!;
    const lines = [...tile.querySelectorAll('span.truncate')];
    expect(lines.map((l) => text(l))).toEqual(['Another hat', '+1 post scoring']);
    expect(text(tile)).toBe('Another hat+1 post scoring');
  });

  // To whoever shortens these again: compacted to "122.4K", a live total that moves by a few
  // points never visibly changes, which hid the live counting Justin asked to see (2026-10-13).
  it('shows each team total in full, with commas, so a live change is visible', () => {
    joinAs('Pink');
    h.standings = {
      ...STANDINGS,
      teams: [
        { team: 'Blue', rank: 1, score: 1_234_567 },
        { team: 'Pink', rank: 2, score: 122_431 },
      ],
    };
    const rows = block().querySelectorAll('[data-testid="event-home-block-standings"] > div');
    expect([...rows].map((r) => text(r))).toEqual(['#1Blue1,234,567', '#2Pink122,431']);
  });

  it('offers Place it on an unplaced hat, and counts the hats that do not fit', () => {
    joinAs('Pink');
    h.hats = [placed(1, 10), unplaced(2), placed(3, 5), placed(4, 1)];
    const el = block();
    expect(el.querySelectorAll('[data-testid="event-home-block-hat"]')).toHaveLength(3);
    expect(text(el)).toContain('+1 more');
    const more = [...el.querySelectorAll('a')].find((a) => text(a) === '+1 more');
    expect(more?.getAttribute('href')).toBe('/events/birthday2026');
    expect(text(el)).toContain('16 points');
    expect(el.querySelector('[data-testid="event-home-block-get-hat"]')).toBeNull();

    act(() => button(el, 'Place it')!.click());
    const [[arg]] = h.trigger.mock.calls as [
      [{ component: unknown; props: { hat: { cosmeticId: number } } }]
    ];
    expect(arg.component).toBe(PlaceHatModal);
    expect(arg.props.hat.cosmeticId).toBe(2);
  });

  it('a cosmetic that is not obtained is not a team', () => {
    h.user = { id: 1 };
    h.cosmetic = { obtained: false, cosmetic: { data: { team: 'Pink' } } };
    const el = block();
    expect(button(el, 'Join and get your free hat')).toBeDefined();
    expect(el.querySelector('[data-testid="event-home-block-standings"]')).toBeNull();
  });

  it('shows no Join to a signed-in viewer while their team is loading', () => {
    joinAs('Pink');
    h.cosmeticLoading = true;
    const el = block();
    expect(button(el, 'Join')).toBeUndefined();
    expect(el.querySelector('[data-testid="event-home-block"]')).toBeNull();
    expect(el.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('the film offers no join once you are on a team', () => {
    joinAs('Pink');
    const el = block();
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label^="Watch"]')!.click());
    const [[arg]] = h.trigger.mock.calls as [[{ props: { onJoin?: unknown } }]];
    expect(arg.props.onJoin).toBeUndefined();
  });
});

describe('the art', () => {
  it('uses the art made for the block, and falls back to the hero', () => {
    const art = (el: HTMLElement) =>
      el.querySelector('[data-testid="event-home-block"]')!.lastElementChild!.querySelector('img');
    const page = (data as unknown as { page: object }).page;
    const own = { ...data, page: { ...page, homeImage: 'home-id' } } as typeof data;
    expect(art(block(false, own))?.getAttribute('data-src')).toBe('home-id');
    act(() => root?.unmount());
    expect(art(block())?.getAttribute('data-src')).toBe('hero-id');
  });

  // To whoever simplifies this back to a gradient overlay: a fixed colour painted over the art
  // never matches the block's radial background behind it, and the seam it left is what Justin
  // asked to remove (2026-10-12). The art fades out through its own alpha instead.
  it('fades the art out by its own alpha, with no colour painted over it', () => {
    const container = block().querySelector('[data-testid="event-home-block"]')!.lastElementChild!;
    expect(container.querySelector('img')?.className).toContain('[mask-image:linear-gradient(');
    expect(container.querySelector('[class*="from-["]')).toBeNull();
  });
});

describe('Your hats', () => {
  // To whoever narrows this room again: at 8px a feed-size hat was pushed about 15px into its tile,
  // the cramped look Justin asked to fix (2026-10-12). Wide, the hats get a feed card's room; where
  // the row scrolls, exactly the padding the scroller leaves them, so it crops none.
  it("gives each hat a feed card's room past the corner, and a scrolling row's padding", () => {
    joinAs('Pink');
    h.hats = [placed(1, 1)];
    const row = block().querySelector('[data-testid="event-home-block-hat"]')!.parentElement!;
    const classes = row.className.split(/\s+/);
    const wide = '@[82.5rem]:';
    expect(classes).toContain(`${wide}[--event-decoration-allowance:${HAT_ALLOWANCE.corner}px]`);
    expect(classes).toContain(`${wide}overflow-visible`);
    const narrow = classes.find((c) => c.startsWith('[--event-decoration-allowance:'));
    const padding = classes.find((c) => c.startsWith('px-['));
    expect(narrow).toBe(`[--event-decoration-allowance:${padding?.slice(4, -1)}]`);
    expect(classes).toContain('overflow-x-auto');
  });

  it('follows the team totals and its hats live while the block is on screen', () => {
    joinAs('Pink');
    h.standings = { ...STANDINGS, teamsTopicId: 'teams', liveTotals: true };
    h.hats = [placed(1, 1), placed(2, 1)];
    block();
    expect(h.teamsLive.at(-1)).toEqual(['birthday2026', 'teams', true]);
    expect(h.hatsLive.at(-1)).toEqual(
      expect.objectContaining({ topicIds: ['topic-1', 'topic-2'], inView: true })
    );
  });

  it('follows nothing off screen', () => {
    joinAs('Pink');
    h.standings = { ...STANDINGS, teamsTopicId: 'teams', liveTotals: true };
    h.hats = [placed(1, 1)];
    h.inView = false;
    block();
    expect(h.teamsLive.at(-1)?.[2]).toBe(false);
    expect(h.hatsLive.at(-1)?.inView).toBe(false);
  });

  it('follows nothing while the scoring engine is switched off', () => {
    joinAs('Pink');
    h.standings = { ...STANDINGS, teamsTopicId: 'teams', liveTotals: false };
    h.hats = [placed(1, 1)];
    block();
    expect(h.teamsLive.at(-1)?.[2]).toBe(false);
    expect(h.hatsLive.at(-1)?.inView).toBe(false);
  });

  it('follows nothing behind the collapsed bar', () => {
    joinAs('Pink');
    h.standings = { ...STANDINGS, teamsTopicId: 'teams', liveTotals: true };
    h.hats = [placed(1, 1)];
    block(true);
    expect(h.teamsLive.at(-1)?.[2]).toBe(false);
  });
});

describe('ended', () => {
  it('names the settled winner with the prize and the final standings, and offers no join', () => {
    vi.setSystemTime(new Date('2026-12-05T00:00:00Z'));
    h.banners = [];
    h.standings = {
      ...STANDINGS,
      updatedAt: new Date('2026-12-04T00:00:00Z'),
      teamsTopicId: 'teams',
    };
    const el = block();
    expect(text(el)).toContain('Team Blue wins.');
    // Frozen, so the winner it names is the settled one.
    expect(h.teamsLive.at(-1)?.[2]).toBe(false);
    expect(text(el)).toContain('Champion badge');
    expect(srcs(el)).toContain('blue-anim');
    expect(
      text(el.querySelector('[data-testid="event-home-block-standings"] [data-mine]'))
    ).toContain('Blue');
    expect(hrefs(el)).toContain('/events/birthday2026');
    expect(button(el, 'Join')).toBeUndefined();
  });
});

describe('ended, still settling', () => {
  it('names no winner and shows no prize until the final standings are in', () => {
    vi.setSystemTime(new Date('2026-12-01T12:00:00Z'));
    h.banners = [];
    h.standings = { ...STANDINGS, updatedAt: new Date('2026-12-01T06:00:00Z') };
    const el = block();
    expect(text(el)).toContain('Final scores are being tallied.');
    expect(text(el)).not.toContain('wins.');
    expect(text(el)).not.toContain('Champion badge');
    expect(srcs(el)).not.toContain('blue-anim');
    expect(el.querySelector('[data-testid="event-home-block-standings"] [data-mine]')).toBeNull();
  });

  it('the collapsed bar names the settled winner', () => {
    vi.setSystemTime(new Date('2026-12-05T00:00:00Z'));
    h.standings = { ...STANDINGS, updatedAt: new Date('2026-12-04T00:00:00Z') };
    const el = block(true);
    expect(text(el.querySelector('[data-testid="event-home-block-collapsed"]'))).toContain(
      'Team Blue won'
    );
  });
});

describe('collapsed', () => {
  it('is one line with Show and a close', () => {
    joinAs('Pink');
    h.hats = [placed(1, 512)];
    const el = block(true);
    expect(el.querySelector('[data-testid="event-home-block"]')).toBeNull();
    expect(text(el.querySelector('[data-testid="event-home-block-collapsed"]'))).toContain(
      'Team Pink is #2 · your hat has earned 512'
    );
    act(() => button(el, 'Show')!.click());
    expect(onExpand).toHaveBeenCalledTimes(1);
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label="Hide this event"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the Event home block row', () => {
  const row = () =>
    mount(React.createElement(EventHomeBlock, { metadata: { event: 'birthday2026' } }));
  const full = (el: HTMLElement) => el.querySelector('[data-testid="event-home-block"]');
  const bar = (el: HTMLElement) => el.querySelector('[data-testid="event-home-block-collapsed"]');

  const rerender = () =>
    act(() =>
      root!.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(EventHomeBlock, { metadata: { event: 'birthday2026' } })
        )
      )
    );

  it('fetches nothing until it first scrolls into view, then stays', () => {
    h.inView = false;
    const el = row();
    expect(h.getDataEnabled.length).toBeGreaterThan(0);
    expect(h.getDataEnabled.every((e) => !e)).toBe(true);
    expect(full(el)).toBeNull();
    h.inView = true;
    rerender();
    expect(h.getDataEnabled.at(-1)).toBe(true);
    expect(full(el)).not.toBeNull();
    h.inView = false;
    rerender();
    expect(h.getDataEnabled.at(-1)).toBe(true);
    expect(full(el)).not.toBeNull();
  });

  it('reads its state from the dismiss cookie, apart from the strip', () => {
    h.dismissed = ['event:birthday2026'];
    let el = row();
    expect(full(el)).not.toBeNull();
    act(() => root?.unmount());
    h.dismissed = ['home:event:birthday2026:collapsed'];
    el = row();
    expect(bar(el)).not.toBeNull();
    act(() => root?.unmount());
    h.dismissed = ['home:event:birthday2026:collapsed', 'home:event:birthday2026'];
    el = row();
    expect(full(el)).toBeNull();
    expect(bar(el)).toBeNull();
  });

  // Must stay last: the dismissed store it writes is module scope.
  it('the first close collapses it, Show brings it back, and the bar close hides it', () => {
    h.dismissed = ['event:birthday2026', 'home:event:other'];
    const saved = () => JSON.parse(vi.mocked(setCookie).mock.calls.at(-1)![1] as string);
    const el = row();
    const collapse = () =>
      el.querySelector<HTMLButtonElement>('button[aria-label="Collapse this event"]')!.click();
    act(collapse);
    expect(full(el)).toBeNull();
    expect(bar(el)).not.toBeNull();
    expect(saved()).toEqual([
      'event:birthday2026',
      'home:event:other',
      'home:event:birthday2026:collapsed',
    ]);
    act(() => button(el, 'Show')!.click());
    expect(full(el)).not.toBeNull();
    expect(saved()).toEqual(['event:birthday2026', 'home:event:other']);
    act(collapse);
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label="Hide this event"]')!.click());
    expect(full(el)).toBeNull();
    expect(bar(el)).toBeNull();
    // The hide replaces the collapse entry: one item holds one of the cookie's capped slots.
    expect(saved()).toEqual(['event:birthday2026', 'home:event:other', 'home:event:birthday2026']);
    expect(vi.mocked(setCookie).mock.calls.at(-1)![0]).toBe('nav-banners-dismissed');
  });
});
