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
  hats: [] as { placedOn?: unknown; cosmeticId: number }[],
  join: vi.fn(async () => undefined),
  trigger: vi.fn(),
  eventData: undefined as unknown,
  dismissed: [] as string[],
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getNavBanners': { useQuery: () => ({ data: h.banners }) },
    'event.getCosmetic': {
      useQuery: (_i: unknown, o?: { enabled?: boolean }) => ({
        data: o?.enabled ? h.cosmetic : undefined,
      }),
    },
    'event.getStandings': { useQuery: () => ({ data: h.standings }) },
    'event.getMyHats': {
      useQuery: (_i: unknown, o?: { enabled?: boolean }) => ({
        data: o?.enabled ? h.hats : undefined,
      }),
    },
    'event.getData': {
      useQuery: (_i: unknown, o?: { enabled?: boolean }) => ({
        data: o?.enabled ? h.eventData : undefined,
      }),
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

// Layout only, and it needs the feed's masonry context.
vi.mock('~/components/HomeBlocks/HomeBlockWrapper', () => ({
  HomeBlockWrapper: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));
vi.mock('~/hooks/useInView', () => ({ useInView: () => ({ ref: () => undefined, inView: true }) }));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMaybeAppContext: () => ({ navBannersDismissed: h.dismissed }),
}));
vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setCookie: vi.fn(),
}));

const { ScoredEventHomeBlock } = await import('~/components/HomeBlocks/ScoredEventHomeBlock');
const { EventHomeBlock } = await import('~/components/HomeBlocks/EventHomeBlock');

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
  page: { headline: 'Civitai turns 4.' },
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
    teamHref: '/events/birthday2026/team',
    homeBlock: {
      eyebrow: "Civitai's 4th Birthday",
      title: 'Civitai turns 4.',
      body: 'Four colour teams.',
      cta: 'See the event',
    },
  },
};
const STANDINGS = {
  updatedAt: NOW,
  teams: [
    { team: 'Blue', rank: 1, score: 1200 },
    { team: 'Pink', rank: 2, score: 800 },
  ],
};

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
const onDismiss = vi.fn();
beforeEach(() => {
  h.user = null;
  h.banners = [BANNER];
  h.cosmetic = undefined;
  h.standings = STANDINGS;
  h.hats = [];
  h.join.mockClear();
  h.eventData = data;
  h.dismissed = [];
  h.trigger.mockClear();
  onDismiss.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
});

function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(ScoredEventHomeBlock, { event: 'birthday2026', data, onDismiss })
      )
    )
  );
  return host;
}
const text = (el: HTMLElement) => el.textContent ?? '';
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => text(b).includes(label));
const hrefs = (el: HTMLElement) => [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));

const joinAs = (team: string) => {
  h.user = { id: 1 };
  h.cosmetic = { obtained: true, cosmetic: { data: { team } } };
};

describe('scored event home block', () => {
  it('shows the promo copy and the standings, and asks a signed-out viewer to join', () => {
    const el = render();
    expect(text(el)).toContain("Civitai's 4th Birthday");
    expect(text(el)).toContain('Four colour teams.');
    const rows = el.querySelector('[data-testid="event-home-block-standings"]');
    expect(text(rows as HTMLElement)).toMatch(/#1Blue1\.2k.*#2Pink800/);
    act(() => button(el, 'Join and get your free hat')!.click());
    expect(h.join).toHaveBeenCalledWith({ event: 'birthday2026' });
    expect(text(el)).not.toContain('Team rosters');
  });

  it('a joined viewer sees their team line, hats to place and the roster link', () => {
    joinAs('Pink');
    h.hats = [{ cosmeticId: 1, placedOn: { entityId: 9 } }, { cosmeticId: 2 }];
    const el = render();
    expect(text(el)).toContain('Team Pink · #2 · 1 of 2 hats placed');
    expect(button(el, 'Join')).toBeUndefined();
    expect(hrefs(el)).toContain('/events/birthday2026/team');

    act(() => button(el, 'Hat your work')!.click());
    const [[arg]] = h.trigger.mock.calls as [[{ props: { hat: { cosmeticId: number } } }]];
    expect(arg.props.hat.cosmeticId).toBe(2);
  });

  it('offers no hat button once every hat is placed', () => {
    joinAs('Blue');
    h.hats = [{ cosmeticId: 1, placedOn: { entityId: 9 } }];
    const el = render();
    expect(text(el)).toContain('1 of 1 hat placed');
    expect(button(el, 'Hat your work')).toBeUndefined();
  });

  it('after the end, names the settled winner and links the results, with no join', () => {
    vi.setSystemTime(new Date('2026-12-05T00:00:00Z'));
    h.banners = []; // promos stop once the event is not playable
    h.standings = { ...STANDINGS, updatedAt: new Date('2026-12-04T00:00:00Z') };
    const el = render();
    expect(text(el)).toContain('Civitai turns 4.');
    expect(text(el)).toContain('Team Blue won.');
    expect(text(el)).toContain('See the results');
    expect(button(el, 'Join')).toBeUndefined();
  });

  it('closes through its own dismiss', () => {
    const el = render();
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label="Hide this event"]')!.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('the Event home block row', () => {
  const block = () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(EventHomeBlock, { metadata: { event: 'birthday2026' } })
        )
      )
    );
    return host;
  };

  it('renders the scored block for a scored event', () => {
    expect(block().querySelector('[data-testid="event-home-block"]')).not.toBeNull();
  });

  it('renders nothing once this block was dismissed, while the strip id alone does not hide it', () => {
    h.dismissed = ['event:birthday2026'];
    expect(block().querySelector('[data-testid="event-home-block"]')).not.toBeNull();
    act(() => root?.unmount());
    h.dismissed = ['home:event:birthday2026'];
    expect(block().querySelector('[data-testid="event-home-block"]')).toBeNull();
  });

  // Must stay last: the dismissed store it writes is module scope.
  it('closing it hides it', () => {
    const el = block();
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label="Hide this event"]')!.click());
    expect(el.querySelector('[data-testid="event-home-block"]')).toBeNull();
  });
});
