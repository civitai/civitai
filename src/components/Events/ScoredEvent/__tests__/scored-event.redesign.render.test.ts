// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import type * as MantineCore from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The scored-event page's hero and section headings: art from the event definition, the accent
 * headline, the joined team block, the bulb string and the winner state, and one heading pattern on
 * every section.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'cosmeticShop.getShop': { useQuery: () => ({ data: [], isLoading: false }) },
  }),
}));
vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineCore>()),
  Modal: () => null,
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
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/components/Metrics/AnimatedCount', () => ({
  AnimatedCount: ({ value }: { value: number }) => React.createElement('span', null, value),
}));
vi.mock('~/components/Countdown/Countdown', () => ({ Countdown: () => null }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/Events/ScoredEvent/EventContentThumb', () => ({
  EventContentThumb: () => null,
}));
vi.mock('react-chartjs-2', () => ({ Line: () => null }));
const headings: string[] = [];
vi.mock('~/components/Events/ScoredEvent/EventSectionHeading', () => ({
  EventSectionHeading: ({ title }: { title: string }) => {
    headings.push(title);
    return React.createElement('h2', null, title);
  },
}));

const { ScoredEventHero } = await import('~/components/Events/ScoredEvent/ScoredEventHero');
const { MyEventHats } = await import('~/components/Events/ScoredEvent/MyEventHats');
const { TeamHatShelf } = await import('~/components/Events/ScoredEvent/TeamHatShelf');
const { TeamStandings, TopHats } = await import('~/components/Events/ScoredEvent/TeamStandings');
const { EventRules } = await import('~/components/Events/ScoredEvent/EventRules');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  headings.length = 0;
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, element)));
  return host;
}

const DAY = 24 * 60 * 60 * 1000;
type HeroProps = React.ComponentProps<typeof ScoredEventHero>;
const page = {
  headline: 'Civitai turns 4.',
  headlineAccent: 'Pick up a hat.',
  heroImage: 'hero-cdn-id',
  summary: 'Four colour teams.',
  steps: [{ title: 'Join', body: 'Get a team.' }],
  prize: { title: 'Champion badge', body: 'For the winning team.' },
};
const eventData = (over: Record<string, unknown> = {}) =>
  ({
    title: "Civitai's 4th Birthday",
    teams: ['Yellow', 'Blue', 'Pink', 'Green'],
    startDate: new Date(Date.now() - DAY),
    endDate: new Date(Date.now() + DAY),
    page,
    ...over,
  } as unknown as HeroProps['data']);
const teamHats = [
  { team: 'Yellow', url: 'hat-yellow' },
  { team: 'Blue', url: 'hat-blue' },
];
const hero = (props: Partial<HeroProps> = {}) =>
  render(
    React.createElement(ScoredEventHero, {
      data: eventData(),
      ended: false,
      onJoin: vi.fn(),
      joining: false,
      teamHats,
      ...props,
    })
  );
const srcs = (el: HTMLElement) => [...el.querySelectorAll('img')].map((i) => i.dataset.src);

describe('hero art (A1)', () => {
  it("draws the event's hero image, not the floating hats", () => {
    const el = hero();
    expect(el.querySelector('[data-testid="hero-art"]')).not.toBeNull();
    expect(srcs(el)).toEqual(['hero-cdn-id']);
  });

  it('falls back to the floating join hats when the event has no art', () => {
    const el = hero({ data: eventData({ page: { ...page, heroImage: undefined } }) });
    expect(el.querySelector('[data-testid="hero-art"]')).toBeNull();
    expect(srcs(el)).toEqual(['hat-yellow', 'hat-blue']);
  });
});

describe('hero headline (A2)', () => {
  it('puts the accent on its own line, in the gradient of every team colour', () => {
    const h1 = hero().querySelector('h1')!;
    const accent = h1.querySelector('span')!;
    expect(h1.firstChild?.textContent).toBe('Civitai turns 4.');
    expect(accent.textContent).toBe('Pick up a hat.');
    expect(accent.style.backgroundImage).toBe(
      'linear-gradient(90deg, #fcc419, #339af0, #f06595, #40c057)'
    );
  });
});

describe('hero team block (A6)', () => {
  it("shows the viewer's team, its hat, rank, team points and their own points", () => {
    const el = hero({ team: 'Blue', rank: 2, teamPoints: 10512, points: 140 });
    const block = el.querySelector('[data-testid="hero-team"]') as HTMLElement;
    expect(srcs(block)).toEqual(['hat-blue']);
    expect(block.textContent).toBe("You're onTeam Blue#2Rank10512Team points140From your hats");
    expect(el.textContent).not.toContain('Join and get your free hat');
  });
});

describe('hero bulbs (A9)', () => {
  it('strings bulbs across the top, cycling the team colours, hidden from assistive tech', () => {
    const bulbs = hero().querySelector('[data-testid="hero-bulbs"]') as HTMLElement;
    expect(bulbs.getAttribute('aria-hidden')).toBe('true');
    const colors = [...bulbs.querySelectorAll('span')].map((s) =>
      s.style.getPropertyValue('--bulb')
    );
    expect(colors).toHaveLength(16);
    expect(colors.slice(0, 5)).toEqual(['#fcc419', '#339af0', '#f06595', '#40c057', '#fcc419']);
  });
});

describe('ended hero (A10)', () => {
  const over = { data: eventData({ endDate: new Date(Date.now() - DAY) }), ended: true };

  it('names the winner in the headline and puts the prize in the hero', () => {
    const el = hero({ ...over, winner: 'Yellow' });
    expect(el.querySelector('h1')!.textContent).toBe("Team Yellow winsCivitai's 4th Birthday");
    expect(el.querySelector('[data-testid="hero-prize"]')?.textContent).toBe(
      'Champion badgeFor the winning team.'
    );
    expect(el.textContent).not.toContain('Four colour teams.');
  });

  it('on a tie at the top keeps the headline, says so, and awards nothing', () => {
    const el = hero(over);
    expect(el.querySelector('h1')!.textContent).toBe('Civitai turns 4.Pick up a hat.');
    expect(el.textContent).toContain('The final standings are a tie at the top.');
    expect(el.querySelector('[data-testid="hero-prize"]')).toBeNull();
  });
});

// SpotlightSurface marks its root with --spotlight-opacity, so this counts spotlight cards.
const spotlights = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('*')].filter((n) =>
    n.style.getPropertyValue('--spotlight-opacity')
  ).length;

describe('spotlight only where you can act (A9)', () => {
  it('the rules, steps and prize render as plain cards', () => {
    const rules = { reactionWeight: 5, viewerOwnerDailyCap: 3, newAccountDays: 7 };
    const el = render(React.createElement(EventRules, { data: eventData({ rules }) }));
    expect(el.textContent).toContain('How points add up');
    expect(el.textContent).toContain('Champion badge');
    expect(spotlights(el)).toBe(0);
  });

  // Positive control: the same count finds the spotlight on a card that keeps it.
  it('the counter does see a spotlight card', () => {
    const el = hero();
    expect(spotlights(el)).toBeGreaterThan(0);
  });
});

describe('section headings (A8)', () => {
  it('every section of the page uses the one heading pattern', () => {
    const standings = {
      teams: [{ team: 'Blue', score: 10, rank: 1 }],
      history: [],
      teamHats,
      topCosmetics: [{ userId: 1, cosmeticId: 5, claimKey: 'claimed', team: 'Blue', points: 3 }],
      cosmetics: { 5: { name: 'Cap', url: 'hat-blue' } },
      users: {},
      updatedAt: new Date(),
    } as unknown as React.ComponentProps<typeof TeamStandings>['standings'];
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(TeamStandings, { standings, myTeam: 'Blue' }),
        React.createElement(TopHats, { standings }),
        React.createElement(MyEventHats, {
          event: 'birthday2026',
          hats: [],
          fetchedAt: Date.now(),
          teamColor: '#339af0',
          ended: false,
        }),
        React.createElement(TeamHatShelf, { event: 'birthday2026', team: 'Blue' }),
        React.createElement(EventRules, { data: eventData() })
      )
    );
    expect(headings).toEqual([
      'Team standings',
      'Hardest-working hats',
      'Your hats',
      'Team Blue hats',
      'How it works',
    ]);
    expect(host!.querySelectorAll('h2')).toHaveLength(5);
  });
});
