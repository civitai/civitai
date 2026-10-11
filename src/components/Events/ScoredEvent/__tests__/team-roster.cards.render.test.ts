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
  status: undefined as { optedIn: boolean; listedTeam: string | null } | undefined,
  user: undefined as { id: number } | undefined,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getTeamRoster': {
      useInfiniteQuery: () => ({
        data: { pages: [{ items: state.items, total: state.items.length, nextCursor: undefined }] },
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
vi.mock('~/hooks/useInView', () => ({
  useInView: () => ({ ref: { current: null }, inView: false }),
}));
vi.mock('~/components/Events/ScoredEvent/event-points-live', () => ({
  RosterLivePoints: () => null,
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
  AnimatedCount: ({ value }: { value: number }) => React.createElement('span', null, value),
}));

const { TeamRoster } = await import('~/components/Events/ScoredEvent/TeamRoster');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.status = undefined;
  state.user = undefined;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
});

function render(items: unknown[]) {
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

  it("drops the viewer's own card once they opt out, and ranks the rest with no gap", () => {
    state.user = { id: 1 };
    state.status = { optedIn: false, listedTeam: null };
    const el = render([
      member(1, { hatCount: 9 }),
      member(2, { hatCount: 8 }),
      member(3, { hatCount: 7 }),
      member(4, { hatCount: 6 }),
    ]);
    expect(el.textContent).not.toContain('user1');
    expect(ranksIn(podium(el))).toEqual(['1', '2', '3']);
    expect(el.textContent).toContain('user4');
  });

  it('fits a shelf of 12 hats as 7 + "+5" on a narrow card and 9 + "+3" on a wide one', () => {
    const hats = Array.from({ length: 12 }, (_, i) => hat(100 + i));
    const el = render([member(1), member(2), member(3), member(4, { hats })]);
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
    const el = render([member(1), member(2), member(3), member(4, { hats })]);
    const card = all(grid(el)!, 'roster-card')[0];
    expect(all(card, 'roster-hat').filter((t) => t.hasAttribute('data-narrow'))).toHaveLength(8);
    expect(all(card, 'roster-more')).toHaveLength(0);
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
      member(1, { joinedAgoMs: 23 * HOUR }),
      member(2, { joinedAgoMs: 25 * HOUR }),
      member(3),
      member(4, { joinedAgoMs: HOUR }),
      member(5, { joinedAgoMs: 24 * HOUR }),
    ]);
    const cards = [...all(podium(el)!, 'roster-podium-card'), ...all(grid(el)!, 'roster-card')];
    expect(cards.map((c) => all(c, 'roster-new').length)).toEqual([1, 0, 0, 1, 0]);
  });

  it('underlines the stat the roster is sorted by', () => {
    const el = render([member(1, { hatCount: 3, points: 50 })]);
    const card = all(podium(el)!, 'roster-podium-card')[0];
    const active = [...card.querySelectorAll('[data-active]')];
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain('hats');
  });

  it('puts the gold dot only on the dearest tier', () => {
    const hats = [
      hat(1, { price: 3000 }),
      hat(2, { price: 1500 }),
      hat(3, { price: 500 }),
      hat(4, { price: null }),
    ];
    const el = render([member(1), member(2), member(3), member(4, { hats })]);
    const tiles = all(all(grid(el)!, 'roster-card')[0], 'roster-hat');
    expect(tiles.map((t) => t.getAttribute('data-tier'))).toEqual(['3', '2', '1', '0']);
    expect(tiles.map((t) => !!t.querySelector('[aria-hidden]'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('says no one has joined when the team has no listed members', () => {
    const el = render([]);
    expect(el.textContent).toContain('No one on Team Pink has joined the roster yet.');
    expect(podium(el)).toBeNull();
  });
});
