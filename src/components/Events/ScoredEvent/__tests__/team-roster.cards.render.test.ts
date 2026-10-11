// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The roster page as cards: the top three of the sort on the podium, everyone after on the grid,
 * ranks that share a tie and leave no gap, and each card's hats fitted to its slots.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 9, 20, 12);
const HOUR = 60 * 60 * 1000;

type Hat = {
  cosmeticId: number;
  name: string;
  url: string | null;
  worn: boolean;
  price: number | null;
};
const hat = (id: number, over: Partial<Hat> = {}): Hat => ({
  cosmeticId: id,
  name: `Hat ${id}`,
  url: `hat-${id}.png`,
  worn: false,
  price: 500,
  ...over,
});
const member = (
  id: number,
  over: { hats?: Hat[]; hatCount?: number; points?: number; joinedAgoMs?: number } = {}
) => {
  const hats = over.hats ?? [];
  return {
    user: { id, username: `user${id}`, image: null, profilePicture: null },
    hats,
    hatCount: over.hatCount ?? hats.length,
    points: over.points ?? 0,
    joinedAt: new Date(NOW - (over.joinedAgoMs ?? 10 * 24 * HOUR)),
    topicId: `topic-${id}`,
  };
};

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  // When set, the roster arrives as these pages instead of one page of `items`.
  pages: undefined as unknown[][] | undefined,
  inView: false,
  liveTopics: [] as string[],
  trigger: undefined as undefined | ((arg: unknown) => void),
  status: undefined as { optedIn: boolean; listedTeam: string | null } | undefined,
  user: undefined as { id: number } | undefined,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getTeamRoster': {
      useInfiniteQuery: () => ({
        data: {
          pages: (state.pages ?? [state.items]).map((items) => ({
            items,
            total: items.length,
            nextCursor: undefined,
          })),
        },
        isLoading: false,
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      }),
    },
    'event.getStandings': {
      useQuery: () => ({ data: { teamHats: [{ team: 'Pink', url: 'team-pink.png' }] } }),
    },
    'event.getMyRosterStatus': { useQuery: () => ({ data: state.status }) },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => 'pink',
}));
// Each card's own in-view state, as the real hook keeps it; `setAllInView` scrolls them all.
const views = vi.hoisted(() => new Set<(inView: boolean) => void>());
vi.mock('~/hooks/useInView', () => ({
  useInView: () => {
    const [inView, setInView] = React.useState(state.inView);
    React.useEffect(() => {
      views.add(setInView);
      return () => void views.delete(setInView);
    }, []);
    return { ref: { current: null }, inView };
  },
}));
const setAllInView = (inView: boolean) => act(() => views.forEach((set) => set(inView)));
// Records which cards' totals the page follows live.
vi.mock('~/components/Events/ScoredEvent/event-points-live', () => ({
  RosterLivePoints: ({ topicIds }: { topicIds: string[] }) => {
    state.liveTopics = topicIds;
    return null;
  },
}));
vi.mock('~/components/Dialog/dialogStore', () => ({
  dialogStore: { trigger: (arg: unknown) => state.trigger?.(arg) },
}));
vi.mock('~/components/Events/ScoredEvent/roster/RosterOptIn', () => ({ RosterOptIn: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/components/Events/ScoredEvent/HatArt', () => ({
  HatArt: ({ url, className }: { url: string; className?: string }) =>
    React.createElement('div', { 'data-hat': url, className }),
}));
vi.mock('~/components/Metrics/AnimatedCount', () => ({
  AnimatedCount: ({ value, animate }: { value: number; animate?: boolean }) =>
    React.createElement('span', { 'data-animate': String(animate) }, value),
}));

const { TeamRoster } = await import('~/components/Events/ScoredEvent/TeamRoster');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.status = undefined;
  state.user = undefined;
  state.pages = undefined;
  state.inView = false;
  state.liveTopics = [];
  state.trigger = undefined;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
});

function render(items: unknown[] = []) {
  state.items = items;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(TeamRoster, {
          event: 'birthday2026',
          teams: ['Pink', 'Blue'],
          initialTeam: 'Pink',
        })
      )
    )
  );
  return host;
}

// Three members ahead of everyone on any sort, so the member under test lands on the grid.
const podiumOf = (hatCount: number) =>
  [1, 2, 3].map((id) => member(id, { hatCount, points: 1_000_000, joinedAgoMs: -id }));
const all = (el: Element, id: string) => [...el.querySelectorAll(`[data-testid="${id}"]`)];
const ranksIn = (el: Element | null) =>
  all(el!, 'roster-rank').map((r) => r.textContent?.replace('#', ''));
const podium = (el: Element) => el.querySelector('[data-testid="roster-podium"]');
const grid = (el: Element) => el.querySelector('[data-testid="roster-grid"]');

describe('TeamRoster cards', () => {
  it('stands the top three on the podium and the rest on the grid, ties sharing the better rank', () => {
    const el = render([
      member(1, { hatCount: 5 }),
      member(2, { hatCount: 4 }),
      member(3, { hatCount: 4 }),
      member(4, { hatCount: 4 }),
      member(5, { hatCount: 1 }),
    ]);
    expect(all(podium(el)!, 'roster-podium-card')).toHaveLength(3);
    expect(ranksIn(podium(el))).toEqual(['1', '2', '2']);
    expect(all(grid(el)!, 'roster-card')).toHaveLength(2);
    expect(ranksIn(grid(el))).toEqual(['2', '5']);
  });

  it('puts the leader in the middle of a wide podium and first on a phone', () => {
    const el = render([member(1), member(2), member(3)]);
    expect(podium(el)!.className).toContain('@sm:grid-cols-3');
    expect(podium(el)!.className).toContain('@sm:pt-4');
    expect(podium(el)!.className).not.toContain('@sm:justify-center');
    const cards = all(podium(el)!, 'roster-podium-card');
    expect(cards[0].className).toContain('@sm:order-2');
    expect(cards[0].className).toContain('col-span-2');
    expect(cards[1].className).toContain('@sm:order-1');
    expect(cards[2].className).toContain('@sm:order-3');
  });

  it('draws no grid with three members or fewer', () => {
    const el = render([member(1), member(2)]);
    expect(all(podium(el)!, 'roster-podium-card')).toHaveLength(2);
    expect(grid(el)).toBeNull();
  });

  // The reported pair: 1 hat each, so "Most hats" was a shared gold #1 on cards at two heights.
  it('ranks two members tied on hats #1 and #2 by points', () => {
    const el = render([
      member(1, { hatCount: 1, points: 953 }),
      member(2, { hatCount: 1, points: 4006 }),
    ]);
    expect(ranksIn(podium(el))).toEqual(['1', '2']);
    expect(all(podium(el)!, 'roster-podium-card')[0].textContent).toContain('user2');
  });

  it.each([1, 2])('stands %i members in a centred row in rank order, with no step', (count) => {
    const el = render(Array.from({ length: count }, (_, i) => member(i + 1)));
    expect(podium(el)!.className).toContain('@sm:justify-center');
    expect(podium(el)!.className).not.toContain('@sm:grid-cols-3');
    expect(podium(el)!.className).not.toContain('@sm:pt-4');
    for (const card of all(podium(el)!, 'roster-podium-card')) {
      expect(card.className).not.toMatch(/-mt-4|order-/);
      expect(card.className).toContain('@sm:w-[calc((100%-1.5rem)/3)]');
    }
    // Alone, the card takes the phone row; two share it.
    const spans = all(podium(el)!, 'roster-podium-card').map((c) =>
      c.className.split(' ').includes('col-span-2')
    );
    expect(spans).toEqual(count === 1 ? [true] : [false, false]);
  });

  it("drops the viewer's own card once they opt out, and ranks the rest with no gap", () => {
    state.user = { id: 1 };
    state.status = { optedIn: false, listedTeam: null };
    // The two behind the viewer tie: ranked without the viewer they are both #1, not #2.
    const el = render([
      member(1, { hatCount: 9 }),
      member(2, { hatCount: 8 }),
      member(3, { hatCount: 8 }),
      member(4, { hatCount: 6 }),
    ]);
    expect(el.textContent).not.toContain('user1');
    expect(ranksIn(podium(el))).toEqual(['1', '1', '3']);
    expect(el.textContent).toContain('user4');
  });

  // Hidden only once the viewer's own uncached status says they are not listed.
  it.each([
    ['listed', { id: 1 }, { optedIn: true, listedTeam: 'Pink' }],
    ['signed out', undefined, undefined],
    ['status still loading', { id: 1 }, undefined],
  ] as const)("keeps the viewer's own card while %s", (_, user, status) => {
    state.user = user;
    state.status = status;
    const el = render([member(1, { hatCount: 9 }), member(2, { hatCount: 8 })]);
    expect(el.textContent).toContain('user1');
  });

  // Pages are read by offset from an edge cache: a member can arrive on two pages, and the 25th can
  // tie the 24th.
  it('ranks across pages, shares a tie at the page boundary, and shows a repeated member once', () => {
    const first = Array.from({ length: 24 }, (_, i) => member(i + 1, { hatCount: 100 - i }));
    const tied = member(25, { hatCount: 100 - 23 });
    state.pages = [first, [first[23], tied]];
    const el = render();
    const cards = all(grid(el)!, 'roster-card');
    expect(cards).toHaveLength(22);
    expect(ranksIn(grid(el)).slice(-2)).toEqual(['24', '24']);
    expect(el.textContent?.split('user24').length).toBe(2);
  });

  // Live points move totals in the cache without re-sorting it.
  it('re-sorts a points roster whose cached totals moved, so ranks and the podium follow', () => {
    const el = render([
      member(1, { points: 10 }),
      member(2, { points: 8 }),
      member(3, { points: 8 }),
      member(4, { points: 50 }),
    ]);
    act(() => el.querySelector<HTMLInputElement>('input[value="points"]')!.click());
    const names = all(podium(el)!, 'roster-podium-card').map((c) => c.textContent);
    expect(names[0]).toContain('user4');
    expect(ranksIn(podium(el))).toEqual(['1', '2', '3']);
    expect(ranksIn(grid(el))).toEqual(['3']);
  });

  it('follows a card live only while it is on screen, and rolls its counts only then', () => {
    let el = render([member(1), member(2)]);
    expect(state.liveTopics).toEqual([]);
    expect(el.querySelector('[data-animate="true"]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    state.inView = true;
    el = render([member(1), member(2)]);
    expect([...state.liveTopics].sort()).toEqual(['topic-1', 'topic-2']);
    expect(el.querySelectorAll('[data-animate="true"]')).toHaveLength(4);
    // Scrolled away: both cards drop out of the live set.
    setAllInView(false);
    expect(state.liveTopics).toEqual([]);
    expect(el.querySelector('[data-animate="true"]')).toBeNull();
  });

  it('opens every hat in the modal from a card’s "+N"', () => {
    const triggered: { component: unknown; props: { username: string; hats: unknown[] } }[] = [];
    state.trigger = (arg) => triggered.push(arg as (typeof triggered)[number]);
    const hats = Array.from({ length: 12 }, (_, i) => hat(100 + i, { worn: i === 0 }));
    const el = render([...podiumOf(30), member(4, { hats })]);
    act(() =>
      all(all(grid(el)!, 'roster-card')[0], 'roster-more')[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    );
    expect(triggered).toHaveLength(1);
    expect(triggered[0].props.username).toBe('user4');
    expect(triggered[0].props.hats).toHaveLength(12);
    expect(triggered[0].props.hats[0]).toMatchObject({ cosmeticId: 100, worn: true });
  });

  it('fits the 9 hats past a podium card\'s hero as 3 + "+6" narrow and 5 + "+4" wide', () => {
    const hats = Array.from({ length: 10 }, (_, i) => hat(100 + i, { worn: i === 0 }));
    const el = render([member(1, { hats })]);
    const card = all(podium(el)!, 'roster-podium-card')[0];
    const tiles = all(card, 'roster-hat');
    expect(tiles).toHaveLength(5);
    expect(tiles.filter((t) => t.hasAttribute('data-narrow'))).toHaveLength(3);
    expect(all(card, 'roster-more').map((m) => m.textContent)).toEqual(['+6', '+4']);
    expect(all(card, 'roster-more')[1].className).toContain('@[220px]:grid');
  });

  // A container query measures its nearest @container: the page's for the podium layout, each
  // card's own for its hat rows. A card without one would measure the whole roster and go wide.
  it('measures the podium layout by the page and each hat row by its own card', () => {
    const hats = Array.from({ length: 12 }, (_, i) => hat(100 + i));
    const el = render([member(1, { hats }), ...[2, 3, 4].map((id) => member(id, { hats }))]);
    const nearest = (node: Element) => node.parentElement?.closest('[class~="@container"]');
    const pageLevel = [...el.querySelectorAll('[class*="@sm:"]')];
    const cardLevel = [...el.querySelectorAll('[class*="@[220px]:"], [class*="@[300px]:"]')];
    expect(pageLevel.length).toBeGreaterThan(0);
    expect(cardLevel.length).toBeGreaterThan(0);
    const cards = [...all(el, 'roster-podium-card'), ...all(el, 'roster-card')];
    for (const node of pageLevel) {
      expect(nearest(node)).toBeTruthy();
      expect(cards).not.toContain(nearest(node));
    }
    for (const node of cardLevel) {
      const card = node.closest('[data-testid="roster-podium-card"], [data-testid="roster-card"]');
      expect(nearest(node)).toBe(card);
    }
  });

  it("borders a shelf card in its team's colour", () => {
    const el = render([...podiumOf(30), member(4)]);
    expect(all(grid(el)!, 'roster-card')[0].getAttribute('style')).toContain('border-color: pink');
  });

  it('tells a viewer on an empty team how to be the first, and only them', () => {
    state.user = { id: 9 };
    state.status = { optedIn: false, listedTeam: null };
    const el = render([]);
    expect(el.textContent).toContain('above to be the first');
    // Another team's empty roster is not theirs to start.
    act(() => el.querySelector<HTMLInputElement>('input[value="Blue"]')!.click());
    expect(el.textContent).toContain('No one on Team Blue');
    expect(el.textContent).not.toContain('above to be the first');
    act(() => root?.unmount());
    host?.remove();
    state.status = { optedIn: true, listedTeam: null };
    expect(render([]).textContent).not.toContain('above to be the first');
    act(() => root?.unmount());
    host?.remove();
    state.status = undefined;
    expect(render([]).textContent).not.toContain('above to be the first');
  });

  it('fits a shelf of 12 hats as 7 + "+5" on a narrow card and 9 + "+3" on a wide one', () => {
    const hats = Array.from({ length: 12 }, (_, i) => hat(100 + i));
    const el = render([...podiumOf(30), member(4, { hats })]);
    const card = all(grid(el)!, 'roster-card')[0];
    const tiles = all(card, 'roster-hat');
    expect(tiles).toHaveLength(9);
    // The two tiles past the narrow plan are hidden until the card is 300px wide.
    expect(tiles.filter((t) => t.hasAttribute('data-narrow'))).toHaveLength(7);
    expect(tiles.slice(7).every((t) => t.className.includes('hidden'))).toBe(true);
    expect(tiles.slice(7).every((t) => t.className.includes('@[300px]:block'))).toBe(true);
    const more = all(card, 'roster-more');
    expect(more.map((m) => m.textContent)).toEqual(['+5', '+3']);
    expect(more[0].className).toContain('@[300px]:hidden');
    expect(more[1].className).toContain('@[300px]:grid');
  });

  it('shows every hat and no "+N" when they fit the narrow shelf', () => {
    const hats = Array.from({ length: 8 }, (_, i) => hat(100 + i));
    const el = render([...podiumOf(30), member(4, { hats })]);
    const card = all(grid(el)!, 'roster-card')[0];
    expect(all(card, 'roster-hat').filter((t) => t.hasAttribute('data-narrow'))).toHaveLength(8);
    expect(all(card, 'roster-more')).toHaveLength(0);
  });

  // Justin: the score in one place on every card, whatever its hats. On a shelf card it sits under
  // the name, above the shelf (one row, two rows, or none); on a podium card, above the mini row.
  it('puts the score directly under the name, above the hats, on every card', () => {
    // Podium members with hats of their own; the grid holds a two-row shelf, one hat, and none.
    const podiumHats = (id: number) =>
      Array.from({ length: 3 }, (_, i) => hat(id * 100 + i, { worn: i === 0 }));
    const el = render([
      ...[1, 2, 3].map((id) =>
        member(id, { hats: podiumHats(id), hatCount: 20, points: 100 - id })
      ),
      member(5, { hats: Array.from({ length: 9 }, (_, i) => hat(10 + i)) }),
      member(4, { hats: [hat(4)] }),
      member(6),
    ]);
    const cards = [...all(podium(el)!, 'roster-podium-card'), ...all(grid(el)!, 'roster-card')];
    expect(cards.map((c) => c.textContent?.match(/user\d/)?.[0])).toEqual([
      'user1',
      'user2',
      'user3',
      'user5',
      'user4',
      'user6',
    ]);
    // The grid really has a two-row shelf: more tiles than one row of five holds.
    expect(all(cards[3], 'roster-hat').length).toBeGreaterThan(5);
    cards.forEach((card, i) => {
      const name = `user${[1, 2, 3, 5, 4, 6][i]}`;
      const stats = card.querySelector('[data-testid="roster-stats"]')!;
      // Directly under the name row: the element before it is the one carrying the name.
      expect(stats.previousElementSibling?.textContent, name).toContain(name);
      const hats = card.querySelector(
        '[data-testid="roster-hat-row"], [data-testid="roster-no-hats"]'
      );
      expect(hats, name).not.toBeNull();
      expect(stats.compareDocumentPosition(hats!), name).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });
  });

  it('says "No hats yet" on a shelf card with no hats', () => {
    const el = render([member(1), member(2), member(3), member(4)]);
    const card = all(grid(el)!, 'roster-card')[0];
    expect(all(card, 'roster-no-hats')).toHaveLength(1);
    expect(all(card, 'roster-hat')).toHaveLength(0);
  });

  it('heroes the worn hat on the podium and keeps it out of the mini row', () => {
    const el = render([
      member(1, { hats: [hat(7, { worn: true, name: 'Crown' }), hat(8), hat(9)] }),
    ]);
    const card = all(podium(el)!, 'roster-podium-card')[0];
    expect(card.querySelector('[data-testid="roster-hero-label"]')?.textContent).toBe(
      'Wearing · Crown'
    );
    expect(
      all(card, 'roster-hat').map((t) => t.querySelector('[data-hat]')?.getAttribute('data-hat'))
    ).toEqual(['hat-8.png', 'hat-9.png']);
  });

  it('heroes the dearest hat as the top hat when none is worn', () => {
    const el = render([member(1, { hats: [hat(7, { name: 'Tiara' }), hat(8)] })]);
    const card = all(podium(el)!, 'roster-podium-card')[0];
    expect(card.querySelector('[data-testid="roster-hero-label"]')?.textContent).toBe(
      'Top hat · Tiara'
    );
  });

  it("ghosts the team's hat on a podium card with no hats and hides the mini row", () => {
    const el = render([member(1)]);
    const card = all(podium(el)!, 'roster-podium-card')[0];
    expect(card.querySelector('[data-testid="roster-hero-label"]')?.textContent).toBe('No hat yet');
    const ghost = card.querySelector('[data-hat="team-pink.png"]');
    expect(ghost?.className).toContain('grayscale');
    expect(all(card, 'roster-hat-row')).toHaveLength(0);
  });

  it('badges a member who joined in the last 24 hours as NEW, on every sort position', () => {
    const el = render([
      // Hats fix the order, so join time cannot: NEW cards land on both the podium and the grid.
      member(1, { hatCount: 5, joinedAgoMs: 23 * HOUR }),
      member(2, { hatCount: 4, joinedAgoMs: 25 * HOUR }),
      member(3, { hatCount: 3 }),
      member(4, { hatCount: 2, joinedAgoMs: HOUR }),
      member(5, { hatCount: 1, joinedAgoMs: 24 * HOUR }),
    ]);
    const cards = [...all(podium(el)!, 'roster-podium-card'), ...all(grid(el)!, 'roster-card')];
    expect(cards.map((c) => all(c, 'roster-new').length)).toEqual([1, 0, 0, 1, 0]);
  });

  it.each([
    ['hats', 'hats'],
    ['points', 'points'],
    ['newest', 'days on team'],
  ])('underlines the stat the roster is sorted by: %s', (sort, label) => {
    const el = render([member(1, { hatCount: 3, points: 50 })]);
    const input = el.querySelector<HTMLInputElement>(`input[value="${sort}"]`)!;
    act(() => input.click());
    const card = all(podium(el)!, 'roster-podium-card')[0];
    const active = [...card.querySelectorAll('[data-active]')];
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain(label);
    // The underline itself, in the team colour, on the active stat's number only.
    const numbers = [...card.querySelectorAll<HTMLElement>('.tabular-nums.leading-5')];
    expect(numbers).toHaveLength(3);
    const lined = numbers.filter((n) => n.style.boxShadow);
    expect(lined).toHaveLength(1);
    expect(lined[0].style.boxShadow).toContain('pink');
    expect(active[0].contains(lined[0])).toBe(true);
  });

  it('puts the gold dot only on the dearest tier', () => {
    const hats = [
      hat(1, { price: 3000 }),
      hat(2, { price: 1500 }),
      hat(3, { price: 500 }),
      hat(4, { price: null }),
    ];
    const el = render([...podiumOf(30), member(4, { hats })]);
    const tiles = all(all(grid(el)!, 'roster-card')[0], 'roster-hat');
    expect(tiles.map((t) => t.getAttribute('data-tier'))).toEqual(['3', '2', '1', '0']);
    expect(tiles.map((t) => !!t.querySelector('[aria-hidden]'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('says the roster is opt-in when the team has no listed members', () => {
    const el = render([]);
    expect(el.textContent).toContain(
      "No one on Team Pink has opted in to the roster yet. The roster only shows members who turn on “Show me on my team's roster”."
    );
    expect(podium(el)).toBeNull();
  });
});
