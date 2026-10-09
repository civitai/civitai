// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The third pass over the scored-event page: compact "Your hats" cards with the action on the
 * picture, the shelf split into price tiers that dress up as they climb, standings beside the chart
 * with a placeholder before scoring, and the prize badge in every team colour.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let shopSections: unknown[] = [];
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'cosmeticShop.getShop': { useQuery: () => ({ data: shopSections, isLoading: false }) },
  }),
}));
const COLORS: Record<string, string> = {
  Yellow: '#fcc419',
  Blue: '#339af0',
  Pink: '#f06595',
  Green: '#40c057',
};
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => (team: string) => COLORS[team],
}));
// The site's Buzz colour: yellow on civitai.com, green on the green site.
let buzzType: 'yellow' | 'green' = 'yellow';
vi.mock('~/components/Buzz/useAvailableBuzz', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAvailableBuzz: () => [buzzType],
}));
const thumbProps = vi.fn();
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: vi.fn() } }));
vi.mock('~/components/CosmeticShop/CosmeticShopItemPreviewModal', () => ({
  CosmeticShopItemPreviewModal: () => null,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/components/Events/ScoredEvent/EventContentThumb', () => ({
  EventContentThumb: (props: Record<string, unknown>) => {
    thumbProps(props);
    return React.createElement('div', { 'data-testid': 'thumb' });
  },
}));
vi.mock('react-chartjs-2', () => ({ Line: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/Countdown/Countdown', () => ({ Countdown: () => null }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/Metrics/AnimatedCount', () => ({
  AnimatedCount: ({ value }: { value: number }) => React.createElement('span', null, value),
}));

const { MyEventHats } = await import('~/components/Events/ScoredEvent/MyEventHats');
const { getBuzzCurrencyConfig } = await import('~/shared/constants/currency.constants');
const { TeamHatShelf } = await import('~/components/Events/ScoredEvent/TeamHatShelf');
const { TeamStandings } = await import('~/components/Events/ScoredEvent/TeamStandings');
const { EventRules } = await import('~/components/Events/ScoredEvent/EventRules');
const { ScoredEventHero } = await import('~/components/Events/ScoredEvent/ScoredEventHero');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, element)));
  return host;
}
const srcs = (el: Element) => [...el.querySelectorAll('img')].map((i) => i.dataset.src);
const DAY = 24 * 60 * 60 * 1000;

describe('Your hats cards', () => {
  const hat = (over: Record<string, unknown>) => ({
    cosmeticId: 31,
    claimKey: 'c',
    name: 'Party Cap - Blue',
    data: { url: 'hat-art' },
    placedOn: null,
    placedAt: null,
    movableAt: null,
    moveCooldownLeftMs: 0,
    points: 1500,
    impressions: 12,
    reactions: 3,
    ...over,
  });
  const placed = {
    entityType: 'Image',
    entityId: 9,
    title: null,
    image: null,
  };
  const cards = (hats: unknown[], ended = false) =>
    render(
      React.createElement(MyEventHats, {
        event: 'birthday2026',
        hats: hats as React.ComponentProps<typeof MyEventHats>['hats'],
        fetchedAt: Date.now(),
        teamColor: '#339af0',
        ended,
      })
    );

  // The popover's layout (Ellie review, 2026-10-09): points on their own in the team colour, beside
  // the four ways that make them up. A card has no room for the words, so each way is its icon
  // and number, with the word kept for screen readers and the tooltip.
  it('shows the points on their own in the team colour, then the four ways as icon and number', () => {
    const card = cards([hat({ placedOn: placed })]).querySelector('[data-testid="my-hat"]')!;
    const stats = card.querySelector('[data-testid="hat-stats"]')!;
    const points = stats.querySelector<HTMLElement>('[data-testid="hat-stat-points"]')!;
    expect(points.textContent).toBe('1.5kpoints');
    expect((points.firstElementChild as HTMLElement).style.color).toBe('#339af0');
    expect(
      [...stats.querySelectorAll<HTMLElement>('[data-way]')].map((w) => [
        w.title,
        w.firstElementChild?.tagName.toLowerCase(),
        w.textContent,
      ])
    ).toEqual([
      ['views', 'svg', '12views'],
      ['reactions', 'svg', '3reactions'],
      // Counted from scoring v2 on; a dash until then, never a 0 the post may not have.
      ['comments', 'svg', '–comments'],
      ['remixes', 'svg', '–remixes'],
    ]);
  });

  it('puts Move on the picture of a worn hat, not under the card', () => {
    const card = cards([hat({ placedOn: placed })]).querySelector('[data-testid="my-hat"]')!;
    const move = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Move')!;
    const picture = card.querySelector('[data-testid="thumb"]')!.parentElement!;
    expect(picture.contains(move)).toBe(true);
    expect(move.className).toContain('absolute');
    expect(card.textContent).toContain('On your image');
  });

  it('shows an unworn hat on its own art, with Place it on the picture', () => {
    const card = cards([hat({})]).querySelector('[data-testid="my-hat"]')!;
    expect(card.querySelector('[data-testid="thumb"]')).toBeNull();
    expect(srcs(card)).toEqual(['hat-art']);
    const place = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Place it')!;
    expect(place.parentElement!.contains(card.querySelector('img'))).toBe(true);
    expect(card.textContent).toContain('Not on anything yet');
  });

  // Justin and Ellie, 2026-10-09: hats are kept after the event, so they can still be moved and
  // placed; only buying another is gone.
  it('still offers Move and Place it once the event has ended, but not another hat', () => {
    const el = cards([hat({ placedOn: placed }), hat({ cosmeticId: 32 })], true);
    expect(el.querySelectorAll('[data-testid="my-hat"]')).toHaveLength(2);
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Move',
      'Place it',
    ]);
    expect(el.querySelector('[data-testid="get-another-hat"]')).toBeNull();
  });

  it('keeps the move cooldown once the event has ended', () => {
    const el = cards([hat({ placedOn: placed, moveCooldownLeftMs: 5 * 60 * 1000 })], true);
    const move = el.querySelector<HTMLButtonElement>('button')!;
    expect(move.textContent).toBe('Move');
    expect(move.disabled).toBe(true);
    expect(el.textContent).toContain('Can move in 5 min');
  });

  // Rows of equal height, so the card is a hat card's size even alone on its row.
  it('sizes every grid row alike', () => {
    const grid = cards([hat({})]).querySelector<HTMLElement>('[data-testid="my-hats-grid"]')!;
    expect(grid.style.gridAutoRows).toBe('1fr');
    expect(grid.lastElementChild?.getAttribute('data-testid')).toBe('get-another-hat');
  });

  it('is a plain card, not a spotlight', () => {
    const el = cards([hat({ placedOn: placed })]);
    const spot = [...el.querySelectorAll<HTMLElement>('*')].filter((n) =>
      n.style.getPropertyValue('--spotlight-opacity')
    );
    expect(spot).toHaveLength(0);
  });
});

describe('Your hats card wears its hat', () => {
  it('on a card that does not clip it, with room for it in the grid', () => {
    thumbProps.mockClear();
    const el = render(
      React.createElement(MyEventHats, {
        event: 'birthday2026',
        hats: [
          {
            cosmeticId: 31,
            claimKey: 'c',
            name: 'Cap',
            data: { url: 'u' },
            placedOn: { entityType: 'Image', entityId: 9, title: null, image: null },
            moveCooldownLeftMs: 0,
            points: 0,
            impressions: 0,
            reactions: 0,
          },
        ] as unknown as React.ComponentProps<typeof MyEventHats>['hats'],
        fetchedAt: Date.now(),
        teamColor: '#339af0',
        ended: false,
      })
    );
    // The hat reaches past the picture's corner, so nothing from the picture up may clip it.
    const clipping: string[] = [];
    for (
      let node = el.querySelector('[data-testid="thumb"]')!.parentElement;
      node && node !== el;
      node = node.parentElement
    )
      if (/overflow-(hidden|clip|auto|scroll)/.test(node.className)) clipping.push(node.className);
    expect(clipping).toEqual([]);
    // The room is the page's gutter at every width: the Container's padding, plus its margin once
    // the scroll area is wider than it.
    expect(
      el
        .querySelector<HTMLElement>('[data-testid="my-hats-grid"]')!
        .style.getPropertyValue('--event-decoration-allowance')
    ).toBe('calc(max(0px, (100cqw - var(--container-size-lg)) / 2) + var(--mantine-spacing-md))');
    expect(thumbProps.mock.lastCall?.[0]).not.toHaveProperty('allowance');
    expect(thumbProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hat: { url: 'u' },
        className: 'rounded-t-[7px]',
        wornOn: { entityType: 'Image', entityId: 9 },
      })
    );
  });
});

describe('team shelf tiers', () => {
  const item = (id: number, title: string, unitAmount: number) => ({
    id,
    title,
    unitAmount,
    availableQuantity: null,
    availableTo: new Date(Date.now() + 9 * DAY),
    meta: {},
    cosmetic: { id: id + 100, data: { url: `hat-${id}` } },
  });
  const shelf = (items: unknown[]) => {
    shopSections = [{ items: items.map((shopItem) => ({ shopItem })) }];
    return render(React.createElement(TeamHatShelf, { event: 'birthday2026', team: 'Blue' }));
  };
  const items = [
    item(4, 'Knight Helm', 3000),
    item(1, 'Bolt Cap', 500),
    item(3, 'Crown', 1500),
    item(2, 'Puff Cap', 500),
  ];

  it('splits the hats by price, cheapest tier first, each under its own divider', () => {
    const tiers = [...shelf(items).querySelectorAll('[data-testid="shelf-tier"]')];
    expect(
      tiers.map((t) => [
        t.firstElementChild!.textContent,
        [...t.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
      ])
    ).toEqual([
      ['500· 2 hats', ['Buy Bolt Cap', 'Buy Puff Cap']],
      ['1,500· 1 hat', ['Buy Crown']],
      ['3,000· 1 hat', ['Buy Knight Helm']],
    ]);
  });

  it('dresses each tier up: plain, then a team border and tint, then a gold foil', () => {
    const tiles = [...shelf(items).querySelectorAll<HTMLButtonElement>('button[data-tier]')];
    expect(tiles.map((t) => t.dataset.tier)).toEqual(['0', '0', '1', '2']);
    const prop = (t: HTMLElement, name: string) => t.style.getPropertyValue(name);
    expect(tiles[0].getAttribute('style')).toBeNull();
    expect(tiles[0].className).not.toContain('--tier-');
    expect(prop(tiles[2], '--tier-border')).toContain('#339af0');
    expect(prop(tiles[2], '--tier-bg')).toContain('#339af0');
    expect(prop(tiles[2], '--tier-bg')).not.toContain('#fcc419');
    expect(prop(tiles[3], '--tier-bg')).toContain('#fcc419');
    expect(prop(tiles[3], '--tier-bg')).toContain('border-box');
    expect(prop(tiles[3], '--tier-border')).toBe('transparent');
    expect(prop(tiles[2], '--tier-shadow')).toContain('#339af0');
    expect(prop(tiles[3], '--tier-shadow')).toContain('#339af0');
    // The properties do nothing unless the tile carries the classes that read them.
    [tiles[2], tiles[3]].forEach((t) =>
      ['var(--tier-bg)', 'var(--tier-border)', 'var(--tier-shadow)'].forEach((reader) =>
        expect(t.className).toContain(reader)
      )
    );
  });

  it('keeps the foil on every tier above the third', () => {
    const tiles = [
      ...shelf([...items, item(5, 'Comet', 5000)]).querySelectorAll<HTMLButtonElement>(
        'button[data-tier]'
      ),
    ];
    expect(tiles.at(-1)!.dataset.tier).toBe('3');
    expect(tiles.at(-1)!.style.getPropertyValue('--tier-bg')).toContain('#fcc419');
  });

  it('does not offer to buy a tile with nothing to buy', () => {
    const el = shelf([{ ...item(9, 'Broken', 500), cosmetic: null }]);
    const tile = el.querySelector<HTMLButtonElement>('button[data-tier]')!;
    expect(tile.disabled).toBe(true);
    expect(tile.getAttribute('aria-label')).toBe('Broken');
  });

  it("prices in the site's Buzz colour, yellow or green, not the team's", () => {
    for (const type of ['yellow', 'green'] as const) {
      buzzType = type;
      const { color } = getBuzzCurrencyConfig(type);
      const el = shelf(items);
      const pills = [...el.querySelectorAll<HTMLElement>('[data-testid="tile-buy"]')];
      expect(pills.map((p) => p.style.color)).toEqual(pills.map(() => color));
      // The bolt on every pill and every tier divider is the currency's own icon in its colour.
      const bolts = [
        ...el.querySelectorAll(
          '[data-testid="tile-buy"] svg, [data-testid="shelf-tier"] > div:first-child svg'
        ),
      ];
      expect(bolts).toHaveLength(pills.length + 3);
      bolts.forEach((b) => expect(b.getAttribute('stroke')).toBe(color));
      act(() => root?.unmount());
      host?.remove();
    }
    buzzType = 'yellow';
  });

  it('says Buy and the price on every tile that can be bought', () => {
    const tiles = [...shelf(items).querySelectorAll('button[data-tier]')];
    expect(tiles.map((t) => t.querySelector('[data-testid="tile-buy"]')?.textContent)).toEqual([
      'Buy500',
      'Buy500',
      'Buy1,500',
      'Buy3,000',
    ]);
  });

  it('shows one undivided grid when every hat costs the same', () => {
    const el = shelf([item(1, 'Bolt Cap', 500), item(2, 'Puff Cap', 500)]);
    const tiers = [...el.querySelectorAll('[data-testid="shelf-tier"]')];
    expect(tiers).toHaveLength(1);
    // No divider: the tier opens straight onto its grid.
    const [first] = [...tiers[0].children].filter((c) => c.tagName !== 'STYLE');
    expect(first.className).toContain('mantine-SimpleGrid-root');
    expect(tiers[0].textContent).not.toContain('2 hats');
  });
});

describe('one card surface', () => {
  // The standings rows, hat cards and shop tiles share the shop tiles' surface, a step lighter
  // than the page in dark mode.
  it('dresses standings rows, hat cards and shop tiles alike', () => {
    shopSections = [
      {
        items: [
          {
            shopItem: {
              id: 1,
              title: 'Bolt Cap',
              unitAmount: 500,
              availableQuantity: null,
              meta: {},
              cosmetic: { id: 101, data: { url: 'hat-1' } },
            },
          },
        ],
      },
    ];
    const standings = {
      teams: [{ team: 'Blue', score: 20, rank: 1 }],
      history: [],
      teamHats: [],
      topCosmetics: [],
      cosmetics: {},
      users: {},
      updatedAt: new Date(),
    } as unknown as React.ComponentProps<typeof TeamStandings>['standings'];
    const el = render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(TeamStandings, { standings, startDate: new Date(2099, 10, 11, 12) }),
        React.createElement(TeamHatShelf, { event: 'birthday2026', team: 'Blue' }),
        React.createElement(MyEventHats, {
          event: 'birthday2026',
          hats: [
            {
              cosmeticId: 31,
              claimKey: 'c',
              name: 'Cap',
              data: { url: 'u' },
              placedOn: null,
              moveCooldownLeftMs: 0,
              points: 0,
              impressions: 0,
              reactions: 0,
            },
          ] as unknown as React.ComponentProps<typeof MyEventHats>['hats'],
          fetchedAt: Date.now(),
          teamColor: '#339af0',
          ended: false,
        })
      )
    );
    const surfaces = [
      el.querySelector('[data-testid="standings-rows"] .mantine-Paper-root')!,
      el.querySelector('button[data-tier]')!,
      el.querySelector('[data-testid="my-hat"]')!,
    ];
    surfaces.forEach((s) =>
      expect(s.className.split(' ')).toEqual(expect.arrayContaining(['bg-white', 'dark:bg-dark-6']))
    );
  });
});

describe('standings beside the chart', () => {
  const standings = {
    teams: [
      { team: 'Yellow', score: 30, rank: 1 },
      { team: 'Blue', score: 20, rank: 2 },
    ],
    history: [],
    teamHats: [],
    topCosmetics: [],
    cosmetics: {},
    users: {},
    updatedAt: new Date(),
  } as unknown as React.ComponentProps<typeof TeamStandings>['standings'];

  it('lays the rows in the left third and the chart area in the rest', () => {
    const el = render(
      React.createElement(TeamStandings, { standings, startDate: new Date(2099, 10, 11, 12) })
    );
    const rows = el.querySelector('[data-testid="standings-rows"]')!;
    const grid = rows.parentElement!;
    expect(grid.className).toContain('@md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]');
    expect(grid.lastElementChild?.getAttribute('data-testid')).toBe('chart-pending');
  });

  it('sketches a line per team, in the team colours, behind the placeholder', () => {
    const el = render(
      React.createElement(TeamStandings, { standings, startDate: new Date(2099, 10, 11, 12) })
    );
    const lines = [...el.querySelectorAll('[data-testid="chart-pending"] polyline')];
    expect(lines.slice(0, 2).map((l) => l.getAttribute('stroke'))).toEqual(['#fcc419', '#339af0']);
  });
});

describe('prize badge', () => {
  // Not in team order, so the banner's order has to come from the teams.
  const prizeBadge = {
    Pink: { animated: 'p-anim', static: 'p-still' },
    Yellow: { animated: 'y-anim', static: 'y-still' },
    Blue: { animated: 'b-anim', static: 'b-still' },
  };
  const page = {
    headline: 'Civitai turns 4.',
    summary: 'Four colour teams.',
    steps: [],
    prize: { title: 'Champion badge', body: 'For the winning team.' },
    prizeBadge,
  };
  const data = {
    title: "Civitai's 4th Birthday",
    teams: ['Yellow', 'Blue', 'Pink', 'Green'],
    startDate: new Date(Date.now() - 2 * DAY),
    endDate: new Date(Date.now() - DAY),
    page,
  } as unknown as React.ComponentProps<typeof EventRules>['data'];

  it('shows the badge in every team colour it comes in, in team order, on the prize banner', () => {
    const prize = render(React.createElement(EventRules, { data })).querySelector(
      '[data-testid="event-prize"]'
    )!;
    expect(srcs(prize.querySelector('[data-testid="event-prize-badges"]')!)).toEqual([
      'y-anim',
      'b-anim',
      'p-anim',
    ]);
  });

  it("puts the winner's colour of the badge in the ended hero", () => {
    const el = render(
      React.createElement(ScoredEventHero, {
        data,
        ended: true,
        winner: 'Blue',
        onJoin: vi.fn(),
        joining: false,
      })
    );
    expect(srcs(el.querySelector('[data-testid="hero-prize"]')!)).toEqual(['b-anim']);
  });

  it('falls back to the prize art for a winner with no badge, and shows none before the end', () => {
    const hero = (props: Record<string, unknown>) =>
      render(
        React.createElement(ScoredEventHero, {
          data: {
            ...data,
            page: { ...page, prize: { ...page.prize, imageUrl: 'prize-art' } },
          } as typeof data,
          onJoin: vi.fn(),
          joining: false,
          ended: true,
          ...props,
        })
      );
    expect(srcs(hero({ winner: 'Green' }).querySelector('[data-testid="hero-prize"]')!)).toEqual([
      'prize-art',
    ]);
    act(() => root?.unmount());
    host?.remove();
    expect(hero({ ended: false }).querySelector('[data-testid="hero-prize"]')).toBeNull();
  });
});
