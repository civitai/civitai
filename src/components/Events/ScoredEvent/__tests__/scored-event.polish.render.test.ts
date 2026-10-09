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

let placeable: unknown[] = [];
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getPlaceableContent': {
      useQuery: () => ({ data: placeable, isLoading: false }),
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
  useEquipContentDecoration: () => ({ equip: vi.fn(), isLoading: false }),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => 'pink',
}));
vi.mock('~/components/Events/ScoredEvent/EventContentThumb', () => ({
  EventContentThumb: () => null,
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

describe('PlaceHatModal tiles', () => {
  // No id or type line: an untitled image is its picture alone, a titled model shows its title.
  it('labels a candidate only with a real title', () => {
    placeable = [
      { entityType: 'Image', entityId: 500, title: null, image: null },
      { entityType: 'Model', entityId: 7, title: 'My LoRA', image: null },
    ];
    const modal = render(
      React.createElement(PlaceHatModal, { event: 'birthday2026', hat: hat(), myHats: [hat()] })
    );
    const labels = [...modal.querySelectorAll('button')].map((b) =>
      [...b.querySelectorAll('p')].map((p) => p.textContent)
    );
    expect(labels).toEqual([[], ['My LoRA']]);
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
    expect(page.querySelector('button')?.disabled).toBe(true);
  });

  it('unlocks the Move button once the server says the cooldown is over', () => {
    const page = hats({ movableAt: new Date(Date.now() + 5 * MINUTE), moveCooldownLeftMs: 0 });
    expect(page.textContent).not.toContain('Can move in');
    expect(page.querySelector('button')?.disabled).toBe(false);
  });

  // The server's count is as of the fetch; the time since then comes off it.
  it('takes the time since the fetch off the server count', () => {
    const page = hats({ moveCooldownLeftMs: 10 * MINUTE }, Date.now() - 3 * MINUTE);
    expect(page.textContent).toContain('Can move in 7 min');
    expect(page.querySelector('button')?.disabled).toBe(true);
  });

  it('unlocks once the cooldown has run out since the fetch', () => {
    const page = hats({ moveCooldownLeftMs: 10 * MINUTE }, Date.now() - 11 * MINUTE);
    expect(page.textContent).not.toContain('Can move in');
    expect(page.querySelector('button')?.disabled).toBe(false);
  });
});
