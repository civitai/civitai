// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';

/**
 * The event page renders a donation event's sections (welcome, team bank, about + charity) or a
 * scored event's, never both. The about + charity block used to be gated only on "your cosmetic is
 * equipped, or the event ended": for a scored event, placing your hat equips it, so a player saw the
 * holiday garland copy and the charity appeal on the birthday page.
 */

const act = (React as unknown as { act: typeof actType }).act;

let queryEvent: ReturnType<typeof EventsUtils.useQueryEvent>;
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useQueryEvent: () => queryEvent,
  useMutateEvent: () => ({ donate: vi.fn(), donating: false }),
}));
const stub = (marker: string) =>
  function Stub() {
    return React.createElement('div', { 'data-section': marker });
  };
vi.mock('~/components/Events/ScoredEvent/ScoredEventSections', () => ({
  ScoredEventSections: stub('scored'),
}));
vi.mock('~/components/Events/WelcomeCard', () => ({ WelcomeCard: stub('welcome') }));
vi.mock('~/components/Events/EventRewards', () => ({ EventRewards: stub('rewards') }));
vi.mock('~/components/Events/EventContributors', () => ({
  EventContributors: stub('contributors'),
}));
vi.mock('~/components/HeroCard/HeroCard', () => ({ HeroCard: stub('charity') }));
vi.mock('~/components/Decorations/HolidayFrame', () => ({ HolidayFrame: stub('garland') }));
vi.mock('~/components/Decorations/Lightbulb', () => ({ Lightbulb: () => null }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/Countdown/Countdown', () => ({ Countdown: () => null }));
vi.mock('react-chartjs-2', () => ({ Line: () => null }));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/Buzz/buzz.utils', () => ({
  useBuzzTransaction: () => ({ conditionalPerformTransaction: vi.fn() }),
}));

const { default: EventPageDetails } = await import('~/pages/events/[slug]');

const DAY = 24 * 60 * 60 * 1000;
const live = { startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY) };
const over = { startDate: new Date(Date.now() - 3 * DAY), endDate: new Date(Date.now() - DAY) };

function setEvent({
  scored,
  equipped,
  window,
}: {
  scored: boolean;
  equipped: boolean;
  window: { startDate: Date; endDate: Date };
}) {
  queryEvent = {
    eventData: { title: 'An event', teams: ['Pink'], scored, ...window },
    eventCosmetic: {
      obtained: true,
      equipped,
      available: true,
      data: { lights: 1 },
      cosmetic: { id: 1, data: { color: 'pink' } },
    },
    teamScores: [],
    teamScoresHistory: [],
    partners: [],
    loading: false,
    loadingHistory: false,
  } as unknown as ReturnType<typeof EventsUtils.useQueryEvent>;
}

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function sectionsOnPage() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(EventPageDetails, { event: 'an-event' })
      )
    )
  );
  const markers = [...host.querySelectorAll('[data-section]')].map((el) =>
    el.getAttribute('data-section')
  );
  const about = [...host.querySelectorAll('h2')].some((h) =>
    h.textContent?.includes('About The Challenge')
  );
  return { markers, about };
}

describe('event page: donation sections never render for a scored event', () => {
  it.each([
    ['live, hat placed', true, live],
    ['live, nothing placed', false, live],
    ['ended', false, over],
  ])('scored event (%s): only the scored sections', (_label, equipped, window) => {
    setEvent({ scored: true, equipped, window });
    const { markers, about } = sectionsOnPage();
    expect(markers).toEqual(['scored']);
    expect(about).toBe(false);
  });

  // Positive controls: the same render does find the donation sections when they apply, so the
  // scored assertions above cannot pass because the page rendered nothing.
  it('donation event, cosmetic equipped: about + charity render', () => {
    setEvent({ scored: false, equipped: true, window: live });
    const { markers, about } = sectionsOnPage();
    expect(markers).toContain('charity');
    expect(markers).toContain('garland');
    expect(about).toBe(true);
  });

  it('donation event, not equipped: welcome renders, about does not', () => {
    setEvent({ scored: false, equipped: false, window: live });
    const { markers, about } = sectionsOnPage();
    expect(markers).toContain('welcome');
    expect(about).toBe(false);
  });
});
