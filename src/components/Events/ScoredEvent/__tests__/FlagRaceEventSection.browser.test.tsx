import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as ImageUtils from '~/components/Image/image.utils';

const h = vi.hoisted(() => ({
  flagRace: true,
  row: null as { event: string; summary: { flags: { imageId: number }[] } } | null,
  images: [] as { id: number }[],
  // What the server served before the viewer's hidden preferences; defaults to `images`.
  served: null as { id: number }[] | null,
  asked: [] as (number[] | undefined)[],
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ flagRace: h.flagRace }),
}));
vi.mock('~/components/HatTurf/FlagRace/FlagRowProviders', () => ({
  useFlagRow: (event: string | undefined) => (event ? h.row : null),
  FlagRowProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useQueryImages: (filters: { ids?: number[] }) => {
    h.asked.push(filters.ids);
    return { images: h.images, flatData: h.served ?? h.images, isLoading: false };
  },
}));
vi.mock('~/components/HatTurf/FlagRace/FlagRacePanel', () => ({
  FlagRacePanel: () => <div data-testid="panel" />,
}));
vi.mock('~/components/HatTurf/FlagRace/FlagRaceTotals', () => ({
  FlagRaceTotals: () => <div data-testid="totals" />,
}));
vi.mock('~/components/Cards/ImageCard', () => ({
  ImageCard: ({ data }: { data: { id: number } }) => <div data-testid="card">{data.id}</div>,
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  ImagesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { cleanup } from 'vitest-browser-react';
import { FlagRaceEventSection } from '../FlagRaceEventSection';
import { renderWithProviders } from '../../../../../test/component-setup';

const section = () => document.querySelector('[data-testid="flag-race-event-section"]');
// Each flag slot in order: a visible flag's id, or 'hidden' for the real hidden-for-you card.
const cards = () =>
  [...document.querySelectorAll('[data-testid="card"], [data-testid="flag-hidden-for-you"]')].map(
    (c) => (c.getAttribute('data-testid') === 'card' ? c.textContent : 'hidden')
  );
const day = (...ids: number[]) => ({
  event: 'birthday2026',
  summary: { flags: ids.map((imageId) => ({ imageId })) },
});

beforeEach(() => {
  h.flagRace = true;
  h.row = day(30, 10, 20);
  h.images = [{ id: 10 }, { id: 20 }, { id: 30 }];
  h.asked = [];
  h.served = null;
});
afterEach(async () => {
  await cleanup();
});

describe('Flag Race on the event page', () => {
  test("shows the panel and the day's flags in the day's order, asking for exactly those images", async () => {
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(section()).not.toBeNull();
    expect(document.querySelector('[data-testid="panel"]')).not.toBeNull();
    expect(cards()).toEqual(['30', '10', '20']);
    expect(h.asked.at(-1)).toEqual([30, 10, 20]);
  });

  test('stands a hidden card in, in its place, for a flag the viewer may not see', async () => {
    // 10's creator has blocked the viewer: served, then taken out by their hidden preferences.
    h.served = [{ id: 30 }, { id: 10 }, { id: 20 }];
    h.images = [{ id: 20 }, { id: 30 }];
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(cards()).toEqual(['30', 'hidden', '20']);
  });

  test('keeps the panel and race so far when the viewer may see none of the flags', async () => {
    h.served = [{ id: 10 }, { id: 20 }, { id: 30 }];
    h.images = [];
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(section()).not.toBeNull();
    expect(document.querySelector('[data-testid="panel"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="totals"]')).not.toBeNull();
    expect(cards()).toEqual(['hidden', 'hidden', 'hidden']);
  });

  test('a flag a moderator removed (not served) gets no card, hidden or otherwise', async () => {
    h.served = [{ id: 30 }, { id: 20 }];
    h.images = [{ id: 30 }, { id: 20 }];
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(cards()).toEqual(['30', '20']);
  });

  test('a failed image fetch shows no hidden cards, only the flags it did get', async () => {
    h.images = [{ id: 30 }];
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(document.querySelector('[data-testid="panel"]')).not.toBeNull();
    expect(cards()).toEqual(['30']);
  });

  test('is hidden between race days and while the Flag Race flag is off', async () => {
    h.row = null;
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(section()).toBeNull();
    await cleanup();

    h.row = day(30, 10, 20);
    h.flagRace = false;
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(section()).toBeNull();
  });
});
