// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import type * as MantineCore from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticsUtil from '~/components/Cosmetics/cosmetics.util';
import type * as EventsUtils from '~/components/Events/events.utils';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * What the scored-event page prints where the server's data and the browser disagree: the hero's
 * date badge (formatting the end date in the viewer's timezone read "Nov 26" in UTC), a picker
 * tile for an untitled image (it read "Image / Image"), and the hat cooldown (comparing movableAt
 * to a browser clock read "Can move in 11 min" for a 10 minute cooldown).
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let placeable: ({ entityType: string } & Record<string, unknown>)[] = [];
let placeableLoading = false;
// The types with another page to load.
let placeableMore: string[] = [];
// Several pages for a type, in place of the single page `placeable` gives it.
let placeablePages: Record<string, unknown[][]> = {};
// Every infinite query the modal opens: its input and its options.
const placeableCalls: {
  input: { event: string; entityType: string };
  opts: {
    enabled: boolean;
    getNextPageParam: (page: { items: unknown[]; nextCursor: number | null }) => unknown;
  };
}[] = [];
const { equip, fetchNextPage } = vi.hoisted(() => ({ equip: vi.fn(), fetchNextPage: vi.fn() }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    // One tab's pages: the fixture's items of the type asked for.
    'event.getPlaceableContentPage': {
      useInfiniteQuery: (input: { event: string; entityType: string }, opts: never) => {
        placeableCalls.push({ input, opts });
        const { entityType } = input;
        const pages = placeablePages[entityType] ?? [
          placeable.filter((p) => p.entityType === entityType),
        ];
        return {
          data: placeableLoading ? undefined : { pages: pages.map((items) => ({ items })) },
          isLoading: placeableLoading,
          hasNextPage: placeableMore.includes(entityType),
          isFetchingNextPage: false,
          fetchNextPage: () => fetchNextPage(entityType),
        };
      },
    },
  }),
}));
vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineCore>()),
  // Rendered inline so the tiles land in the test's host rather than a portal.
  Modal: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) =>
    React.createElement('div', null, title, children),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
vi.mock('~/components/Cosmetics/cosmetics.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticsUtil>()),
  useEquipContentDecoration: () => ({ equip, isLoading: false }),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => 'pink',
}));
vi.mock('~/components/Events/ScoredEvent/EventContentThumb', () => ({
  // Records which tile wears a hat, by the hat's art, and how wide a picture it asks for.
  EventContentThumb: ({ hat, displayWidth }: { hat?: { url: string }; displayWidth?: number }) =>
    React.createElement('span', { 'data-hat': hat?.url, 'data-display-width': displayWidth }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));
vi.mock('~/components/Countdown/Countdown', () => ({ Countdown: () => null }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => children,
}));

const { ScoredEventHero } = await import('~/components/Events/ScoredEvent/ScoredEventHero');
const { default: PlaceHatModal } = await import('~/components/Events/ScoredEvent/PlaceHatModal');
const { MyEventHats } = await import('~/components/Events/ScoredEvent/MyEventHats');

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

const MINUTE = 60_000;
const hero = (page: { headline: string; dates?: string }) =>
  render(
    React.createElement(ScoredEventHero, {
      data: {
        title: 'Birthday',
        teams: ['Yellow', 'Blue', 'Pink', 'Green'],
        startDate: new Date('2026-11-11T08:00:00.000Z'),
        endDate: new Date('2026-11-26T08:00:00.000Z'),
        page,
      } as unknown as React.ComponentProps<typeof ScoredEventHero>['data'],
      ended: false,
      onJoin: vi.fn(),
      joining: false,
    })
  );
// The only badge on a hero with no preview and no team is the date badge.
const badges = (page: HTMLElement) =>
  [...page.querySelectorAll('.mantine-Badge-label')].map((b) => b.textContent);

describe('ScoredEventHero date badge', () => {
  it("shows the event's own dates verbatim, untouched by the viewer's timezone", () => {
    const page = hero({ headline: 'Hats', dates: 'November 11 to 25' });
    expect(badges(page)).toEqual(['November 11 to 25']);
  });

  // Positive control: without `dates` the badge still prints a range, so the arm above cannot pass
  // because the badge is missing.
  it('falls back to the formatted start and end without one', () => {
    const page = hero({ headline: 'Hats' });
    const [badge, ...rest] = badges(page);
    expect(badge).toMatch(/^Nov 11 to Nov 2[56]$/);
    expect(rest).toEqual([]);
  });
});

type MyHat = React.ComponentProps<typeof PlaceHatModal>['hat'];
const hat = (over: Partial<MyHat> = {}) =>
  ({
    cosmeticId: 31,
    claimKey: 'claimed',
    name: 'Party Cap',
    data: { url: 'u' },
    placedOn: null,
    placedAt: null,
    movableAt: null,
    moveCooldownLeftMs: 0,
    points: 0,
    impressions: 0,
    reactions: 0,
    ...over,
  } as MyHat);

describe('PlaceHatModal tabs', () => {
  const modal = (over: Partial<MyHat> = {}) =>
    render(
      React.createElement(PlaceHatModal, {
        event: 'birthday2026',
        hat: hat(over),
        myHats: [hat(over)],
      })
    );
  const tabLabels = (page: HTMLElement) =>
    [...page.querySelectorAll('.mantine-SegmentedControl-label')].map((l) => l.textContent);
  const pickTab = (page: HTMLElement, label: RegExp) => {
    const el = [...page.querySelectorAll('.mantine-SegmentedControl-label')].find((l) =>
      label.test(l.textContent ?? '')
    ) as HTMLElement;
    act(() => el.click());
  };
  const tileIds = (page: HTMLElement) =>
    [...page.querySelectorAll('button[data-tile]'), ...page.querySelectorAll('div[data-tile]')]
      .map((b) => b.getAttribute('data-tile'))
      .sort();
  afterEach(() => {
    placeableLoading = false;
    placeableMore = [];
    placeablePages = {};
    placeableCalls.length = 0;
    fetchNextPage.mockClear();
  });

  // Each tab asks for this event's content of its own type; the next page starts at the server's
  // cursor, and a null cursor means there is none.
  it('asks for each type of this event, paging on the server cursor', () => {
    placeable = [];
    modal();
    const last = placeableCalls.slice(-3);
    expect(last.map((c) => [c.input.event, c.input.entityType, c.opts.enabled])).toEqual([
      ['birthday2026', 'Image', true],
      ['birthday2026', 'Model', true],
      ['birthday2026', 'Article', true],
    ]);
    const next = last[1].opts.getNextPageParam;
    expect(next({ items: [], nextCursor: 24 })).toBe(24);
    expect(next({ items: [], nextCursor: null })).toBeUndefined();
  });

  // A hat with nowhere to go fetches nothing at all.
  it('fetches nothing for an event whose hat has no types', () => {
    placeable = [];
    const page = render(
      React.createElement(PlaceHatModal, { event: 'no-such-event', hat: hat(), myHats: [hat()] })
    );
    expect(placeableCalls.map((c) => [c.input.event, c.opts.enabled])).toEqual([
      ['no-such-event', false],
      ['no-such-event', false],
      ['no-such-event', false],
    ]);
    expect(page.textContent).toContain('Nothing you publish can wear this hat.');
  });

  // An offset page can repeat a model published between two loads: it is listed once.
  it('lists a model repeated across two pages once', () => {
    const m = (entityId: number) => ({
      entityType: 'Model',
      entityId,
      title: `M${entityId}`,
      image: null,
    });
    placeablePages = {
      Model: [
        [m(7), m(8)],
        [m(8), m(9)],
      ],
    };
    const page = modal();
    pickTab(page, /^Models/);
    expect(tileIds(page)).toEqual(['Model:7', 'Model:8', 'Model:9']);
    expect(tabLabels(page)[1]).toBe('Models 3');
  });

  // One tab per type the hat can go on, each with its own count; "+" while it has more to load.
  it('labels each type with its own count', () => {
    placeable = [
      { entityType: 'Image', entityId: 500, title: null, image: null },
      { entityType: 'Image', entityId: 501, title: null, image: null },
      { entityType: 'Model', entityId: 7, title: 'My LoRA', modelType: 'LORA', image: null },
    ] as never;
    placeableMore = ['Model'];
    expect(tabLabels(modal())).toEqual(['Images 2', 'Models 1+', 'Articles 0']);
  });

  // The grid holds one type at a time: images and models no longer share it.
  it('lists only the open tab, and switches on a click', () => {
    placeable = [
      { entityType: 'Image', entityId: 500, title: null, image: null },
      { entityType: 'Model', entityId: 7, title: 'My LoRA', modelType: 'LORA', image: null },
      { entityType: 'Article', entityId: 9, title: 'Notes', image: null },
    ] as never;
    const page = modal();
    expect(tileIds(page)).toEqual(['Image:500']);
    pickTab(page, /^Models/);
    expect(tileIds(page)).toEqual(['Model:7']);
    pickTab(page, /^Articles/);
    expect(tileIds(page)).toEqual(['Article:9']);
  });

  // A model shows its type and an article says it is one, on every card, cover or not.
  it('badges models with their type and articles as articles', () => {
    placeable = [
      { entityType: 'Image', entityId: 500, title: null, image: null },
      { entityType: 'Model', entityId: 7, title: 'My LoRA', modelType: 'LORA', image: null },
      { entityType: 'Article', entityId: 9, title: 'Notes', image: null },
    ] as never;
    const page = modal();
    const types = () =>
      [...page.querySelectorAll('[data-testid="placeable-type"]')].map((b) => b.textContent);
    expect(types()).toEqual([]);
    pickTab(page, /^Models/);
    expect(types()).toEqual(['LoRA']);
    pickTab(page, /^Articles/);
    expect(types()).toEqual(['Article']);
  });

  it("opens on the type the hat is on now, even when it isn't the first", () => {
    placeable = [
      { entityType: 'Image', entityId: 500, title: null, image: null },
      { entityType: 'Article', entityId: 9, title: 'Notes', image: null },
    ] as never;
    const placedOn = { entityType: 'Article', entityId: 9 } as MyHat['placedOn'];
    expect(tileIds(modal({ placedOn }))).toEqual(['Article:9']);
  });

  it('says what to make on a tab with nothing in it, and links to making one', () => {
    placeable = [{ entityType: 'Image', entityId: 500, title: null, image: null }] as never;
    const page = modal();
    expect(page.querySelector('[data-testid="placeable-empty"]')).toBeNull();
    pickTab(page, /^Models/);
    const empty = page.querySelector('[data-testid="placeable-empty"]')!;
    expect(empty.textContent).toContain("You haven't published a model yet.");
    expect(empty.querySelector('a')?.getAttribute('href')).toBe('/models/create');
    pickTab(page, /^Articles/);
    expect(page.querySelector('[data-testid="placeable-empty"] a')?.getAttribute('href')).toBe(
      '/articles/create'
    );
  });

  // Paging is per tab: Show more loads the open tab's next page and no other.
  it('shows more of the open tab only', () => {
    placeable = [
      { entityType: 'Image', entityId: 500, title: null, image: null },
      { entityType: 'Model', entityId: 7, title: 'My LoRA', image: null },
    ] as never;
    placeableMore = ['Model'];
    const page = modal();
    const showMore = () =>
      [...page.querySelectorAll('button')].find((b) => b.textContent === 'Show more');
    expect(showMore()).toBeUndefined();
    pickTab(page, /^Models/);
    act(() => showMore()!.click());
    expect(fetchNextPage.mock.calls).toEqual([['Model']]);
  });

  it('shows a loader, not an empty state, until the tab has loaded', () => {
    placeableLoading = true;
    placeable = [];
    const page = modal();
    expect(page.querySelector('.mantine-Loader-root')).not.toBeNull();
    expect(page.querySelector('[data-testid="placeable-empty"]')).toBeNull();
  });
});

describe('PlaceHatModal tiles', () => {
  // No id or type line: an untitled image is its picture alone, a titled model shows its title.
  it('labels a candidate only with a real title', () => {
    placeable = [
      { entityType: 'Image', entityId: 500, title: null, image: null },
      { entityType: 'Image', entityId: 501, title: 'Sunset', image: null },
    ] as never;
    const modal = render(
      React.createElement(PlaceHatModal, { event: 'birthday2026', hat: hat(), myHats: [hat()] })
    );
    const labels = [...modal.querySelectorAll('button[data-tile]')].map((b) =>
      [...b.querySelectorAll('p')].map((p) => p.textContent)
    );
    expect(labels).toEqual([[], ['Sunset']]);
  });

  // Four to a row in a modal, its cards are smaller than Your hats': it asks for less picture.
  it('asks for pictures sized to its own smaller cards', () => {
    placeable = [{ entityType: 'Image', entityId: 500, title: null, image: null }];
    const modal = render(
      React.createElement(PlaceHatModal, { event: 'birthday2026', hat: hat(), myHats: [hat()] })
    );
    expect(modal.querySelector('[data-display-width]')?.getAttribute('data-display-width')).toBe(
      '320'
    );
  });

  // A feed-sized hat on the first tile reaches about 24px past it at rest and twice that grown;
  // the modal crops anything further, so the grid makes room for the rest pose and holds it there.
  it('gives a worn hat room past the first tiles and does not grow it', () => {
    placeable = [{ entityType: 'Image', entityId: 500, title: null, image: null }];
    const modal = render(
      React.createElement(PlaceHatModal, { event: 'birthday2026', hat: hat(), myHats: [hat()] })
    );
    const grid = modal.querySelector('button')!.parentElement!;
    expect(grid.className.split(' ')).toEqual(
      expect.arrayContaining(['pl-6', 'pt-6', '[--event-decoration-grow:1]'])
    );
  });

  // A browser drops real clicks inside a disabled button, so the wearing tile is no button at all
  // and its hat bursts. The real-click check is PlaceHatModal.wearing-hat.browser.test.tsx; this
  // pins the structure in the unit suite.
  it('keeps the hat on the wearing tile out of any button', () => {
    placeable = [
      { entityType: 'Image', entityId: 500, title: null, image: null },
      { entityType: 'Image', entityId: 501, title: null, image: null },
    ];
    const placedOn = { entityType: 'Image', entityId: 500 } as MyHat['placedOn'];
    const worn = hat({ placedOn, data: { type: 'hat', event: 'birthday2026', url: 'u' } as never });
    const modal = render(
      React.createElement(PlaceHatModal, { event: 'birthday2026', hat: worn, myHats: [worn] })
    );
    // EventContentThumb (which draws the hat) is mocked here; its tile is what must not be a button.
    const wearing = [...modal.querySelectorAll('p')].find(
      (p) => p.textContent === 'Wearing this hat now'
    )!;
    expect(wearing.closest('button')).toBeNull();
    // The wearing tile still shows the hat.
    expect(wearing.parentElement!.querySelector('[data-hat="u"]')).not.toBeNull();
    const tiles = [...modal.querySelectorAll('button')].filter(
      (b) => !b.hasAttribute('data-event-decoration')
    );
    expect(tiles).toHaveLength(1);
    // And it still can't be picked, while the other post can.
    equip.mockClear();
    act(() => wearing.click());
    expect(equip).not.toHaveBeenCalled();
    act(() => tiles[0].click());
    expect(equip).toHaveBeenCalledWith(
      expect.objectContaining({ equippedToType: 'Image', equippedToId: 501 })
    );
  });
});

describe('MyEventHats cooldown', () => {
  const hats = (over: Partial<MyHat>, fetchedAt = Date.now()) =>
    render(
      React.createElement(MyEventHats, {
        event: 'birthday2026',
        hats: [hat({ placedAt: new Date(), ...over })],
        fetchedAt,
        teamColor: 'pink',
        ended: false,
      })
    );

  // A browser clock a minute behind the server's puts movableAt 11 minutes ahead of it. The wait
  // shown is the server's remaining cooldown, so it still reads 10.
  it("counts down the server's remaining cooldown, not movableAt against the browser clock", () => {
    const page = hats({
      movableAt: new Date(Date.now() + 11 * MINUTE),
      moveCooldownLeftMs: 10 * MINUTE,
    });
    expect(page.textContent).toContain('Can move in 10 min');
    expect(page.querySelector<HTMLButtonElement>('[data-testid="my-hat"] button')?.disabled).toBe(
      true
    );
  });

  it('unlocks the Move button once the server says the cooldown is over', () => {
    const page = hats({ movableAt: new Date(Date.now() + 5 * MINUTE), moveCooldownLeftMs: 0 });
    expect(page.textContent).not.toContain('Can move in');
    expect(page.querySelector<HTMLButtonElement>('[data-testid="my-hat"] button')?.disabled).toBe(
      false
    );
  });

  // The server's count is as of the fetch; the time since then comes off it.
  it('takes the time since the fetch off the server count', () => {
    const page = hats({ moveCooldownLeftMs: 10 * MINUTE }, Date.now() - 3 * MINUTE);
    expect(page.textContent).toContain('Can move in 7 min');
    expect(page.querySelector<HTMLButtonElement>('[data-testid="my-hat"] button')?.disabled).toBe(
      true
    );
  });

  it('unlocks once the cooldown has run out since the fetch', () => {
    const page = hats({ moveCooldownLeftMs: 10 * MINUTE }, Date.now() - 11 * MINUTE);
    expect(page.textContent).not.toContain('Can move in');
    expect(page.querySelector<HTMLButtonElement>('[data-testid="my-hat"] button')?.disabled).toBe(
      false
    );
  });
});
