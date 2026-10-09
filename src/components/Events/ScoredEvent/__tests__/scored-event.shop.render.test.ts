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
 * The scored-event page's shop half: event hat tiles on the team shelf, the catalogue a visitor
 * sees before joining, the standings rows, and the "get another hat" card.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
let shopSections: unknown[] = [];
let catalog: unknown[] | undefined = [];
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'cosmeticShop.getShop': { useQuery: () => ({ data: shopSections, isLoading: false }) },
    'event.getHatCatalog': { useQuery: () => ({ data: catalog }) },
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
const trigger = vi.fn();
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger } }));
vi.mock('~/components/CosmeticShop/CosmeticShopItemPreviewModal', () => ({
  CosmeticShopItemPreviewModal: function PreviewModal() {
    return null;
  },
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/components/Currency/CurrencyBadge', () => ({
  CurrencyBadge: ({ unitAmount }: { unitAmount: number }) =>
    React.createElement('span', null, `${unitAmount} Buzz`),
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/Events/ScoredEvent/EventContentThumb', () => ({
  EventContentThumb: () => null,
}));
vi.mock('react-chartjs-2', () => ({
  Line: function Chart() {
    return React.createElement('canvas', { 'data-testid': 'chart' });
  },
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));

const { TeamHatShelf } = await import('~/components/Events/ScoredEvent/TeamHatShelf');
const { HatCatalogPreview } = await import('~/components/Events/ScoredEvent/HatCatalogPreview');
const { TeamStandings, TopHats } = await import('~/components/Events/ScoredEvent/TeamStandings');
const { MyEventHats } = await import('~/components/Events/ScoredEvent/MyEventHats');
const { CosmeticShopItemPreviewModal } = await import(
  '~/components/CosmeticShop/CosmeticShopItemPreviewModal'
);

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  trigger.mockClear();
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, element)));
  return host;
}
const srcs = (el: Element) => [...el.querySelectorAll('img')].map((i) => i.dataset.src);

const shopItem = (id: number, title: string, unitAmount: number, over: object = {}) => ({
  id,
  title,
  unitAmount,
  availableQuantity: null,
  availableTo: new Date(Date.now() + 17 * DAY + 3600_000),
  meta: {},
  cosmetic: { id: id + 100, data: { url: `hat-${id}` } },
  ...over,
});

describe('team shelf (A3)', () => {
  const items = [
    shopItem(2, 'Crown', 1500),
    shopItem(1, 'Bolt Cap', 500, { availableTo: new Date(Date.now() + 9 * DAY + 3600_000) }),
    shopItem(3, 'Sold Cap', 500, { availableQuantity: 5, meta: { purchases: 5 } }),
  ];
  const shelf = () => {
    shopSections = [{ items: items.map((shopItem) => ({ shopItem })) }];
    return render(React.createElement(TeamHatShelf, { event: 'birthday2026', team: 'Blue' }));
  };
  const tiles = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-testid="hat-catalog"], button')].filter((b) =>
      b.querySelector('img')
    ) as HTMLButtonElement[];

  it('lists each hat as a tile: its art, its name and price, cheapest first', () => {
    const el = shelf();
    expect(el.querySelector('#team-hats')).not.toBeNull();
    expect(tiles(el).map((t) => [srcs(t)[0], t.textContent])).toEqual([
      ['hat-1', 'Bolt Cap500 Buzz'],
      ['hat-3', 'Sold Cap500 BuzzSold out'],
      ['hat-2', 'Crown1500 Buzz'],
    ]);
  });

  it('says when the hats leave once, from the earliest end, not on every tile', () => {
    const el = shelf();
    const leaves = el.querySelectorAll('[data-testid="shelf-leaves"]');
    expect(leaves).toHaveLength(1);
    expect(leaves[0].textContent).toBe('Leaves in 9 days');
    expect(el.textContent?.match(/Leaves/g)).toHaveLength(1);
  });

  it("opens the shop's own preview for the tile's item", () => {
    const el = shelf();
    act(() => tiles(el)[2].click());
    expect(trigger).toHaveBeenCalledWith({
      component: CosmeticShopItemPreviewModal,
      props: { shopItem: items[0] },
    });
  });

  it('does not open a sold-out hat', () => {
    const el = shelf();
    const sold = tiles(el)[1];
    expect(sold.disabled).toBe(true);
    act(() => sold.click());
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe('catalogue before joining (A5)', () => {
  const teams = ['Yellow', 'Blue', 'Pink', 'Green'];
  const designs = Array.from({ length: 14 }, (_, i) => ({
    design: `d${i}`,
    name: `Design ${i}`,
    hats: teams.map((team) => ({ team, url: `d${i}-${team}` })),
  }));
  const preview = (onJoin = vi.fn()) =>
    render(
      React.createElement(HatCatalogPreview, { event: 'birthday2026', onJoin, joining: false })
    );

  it('shows twelve designs, cycling the team colours, and counts the rest', () => {
    catalog = designs;
    const el = preview();
    const grid = el.querySelector('[data-testid="hat-catalog"]')!;
    expect(srcs(grid)).toEqual(designs.slice(0, 12).map((d, i) => `d${i}-${teams[i % 4]}`));
    expect(el.querySelector('h2')?.textContent).toBe('14 hats to collect');
    expect(el.textContent).toContain('and 2 more designs');
    expect(el.textContent).not.toMatch(/Buzz|\d{3,} /);
  });

  it('joins from its button', () => {
    catalog = designs;
    const onJoin = vi.fn();
    const el = preview(onJoin);
    const button = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Join and get your free hat')
    )!;
    act(() => button.click());
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without designs', () => {
    catalog = [];
    expect(preview().querySelector('[data-testid="hat-catalog"]')).toBeNull();
  });
});

describe('standings rows (A7)', () => {
  const standings = (history: unknown[] = []) =>
    ({
      teams: [
        { team: 'Yellow', score: 30, rank: 1 },
        { team: 'Blue', score: 20, rank: 2 },
      ],
      history,
      teamHats: [
        { team: 'Yellow', url: 'hat-yellow' },
        { team: 'Blue', url: 'hat-blue' },
      ],
      topCosmetics: [{ userId: 1, cosmeticId: 5, claimKey: 'c', team: 'Blue', points: 3 }],
      cosmetics: { 5: { name: 'Cap', url: 'hat-blue' } },
      users: {},
      updatedAt: new Date(),
    } as unknown as React.ComponentProps<typeof TeamStandings>['standings']);
  const later = new Date(Date.UTC(2099, 10, 11, 12));

  it("puts each team's hat on its row and lights only the viewer's row", () => {
    const el = render(
      React.createElement(TeamStandings, {
        standings: standings(),
        myTeam: 'Blue',
        startDate: later,
      })
    );
    const rows = [...el.querySelector('[data-testid="standings-rows"]')!.children] as HTMLElement[];
    expect(rows.map((r) => srcs(r))).toEqual([['hat-yellow'], ['hat-blue']]);
    expect(rows.map((r) => r.dataset.mine ?? null)).toEqual([null, 'true']);
    expect(rows[0].style.boxShadow).toBe('');
    expect(rows[1].style.boxShadow).toContain('#339af0');
  });

  it('before any scoring, shows one line saying when it starts instead of an empty chart', () => {
    const el = render(
      React.createElement(TeamStandings, { standings: standings(), startDate: later })
    );
    expect(el.querySelector('[data-testid="chart"]')).toBeNull();
    expect(el.querySelector('[data-testid="chart-pending"]')?.textContent).toBe(
      ' Scoring starts Nov 11. The chart fills in from there.'
    );
  });

  // Positive control: with scores the chart renders and the pending line goes.
  it('draws the chart once there are scores', () => {
    const history = [{ team: 'Yellow', scores: [{ date: new Date(), score: 30 }] }];
    const el = render(
      React.createElement(TeamStandings, { standings: standings(history), startDate: later })
    );
    expect(el.querySelector('[data-testid="chart"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="chart-pending"]')).toBeNull();
  });

  it('top hats is a plain card, not a spotlight', () => {
    const el = render(React.createElement(TopHats, { standings: standings() }));
    expect(el.textContent).toContain('Hardest-working hats');
    const spot = [...el.querySelectorAll<HTMLElement>('*')].filter((n) =>
      n.style.getPropertyValue('--spotlight-opacity')
    );
    expect(spot).toHaveLength(0);
  });
});

describe('get another hat (A11)', () => {
  const hats = (ended: boolean) =>
    render(
      React.createElement(MyEventHats, {
        event: 'birthday2026',
        hats: [
          {
            cosmeticId: 31,
            claimKey: 'c',
            name: 'Party Cap',
            data: { url: 'u' },
            placedOn: null,
            placedAt: null,
            movableAt: null,
            moveCooldownLeftMs: 0,
            points: 0,
            impressions: 0,
            reactions: 0,
          },
        ] as unknown as React.ComponentProps<typeof MyEventHats>['hats'],
        fetchedAt: Date.now(),
        teamColor: '#339af0',
        ended,
      })
    );

  it('ends the grid with a card that goes to the team shelf', () => {
    const card = hats(false).querySelector('[data-testid="get-another-hat"]');
    expect(card?.getAttribute('href')).toBe('#team-hats');
    expect(card?.textContent).toContain('Get another hat');
  });

  it('is gone once the event has ended', () => {
    expect(hats(true).querySelector('[data-testid="get-another-hat"]')).toBeNull();
  });
});
