import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as ImageUtils from '~/components/Image/image.utils';

const h = vi.hoisted(() => ({
  flagRace: true,
  row: null as { event: string; summary: { flags: { imageId: number }[] } } | null,
  images: [] as { id: number }[],
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
    return { images: h.images, isLoading: false };
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
vi.mock('~/components/HatTurf/FlagRace/HiddenFlagCard', () => ({
  HiddenFlagCard: ({ imageId }: { imageId: number }) => (
    <div data-testid="card">hidden {imageId}</div>
  ),
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  ImagesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { cleanup } from 'vitest-browser-react';
import { FlagRaceEventSection } from '../FlagRaceEventSection';
import { renderWithProviders } from '../../../../../test/component-setup';

const section = () => document.querySelector('[data-testid="flag-race-event-section"]');
const cards = () =>
  [...document.querySelectorAll('[data-testid="card"]')].map((c) => c.textContent);
const day = (...ids: number[]) => ({
  event: 'birthday2026',
  summary: { flags: ids.map((imageId) => ({ imageId })) },
});

beforeEach(() => {
  h.flagRace = true;
  h.row = day(30, 10, 20);
  h.images = [{ id: 10 }, { id: 20 }, { id: 30 }];
  h.asked = [];
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
    // 20's creator has blocked the viewer, so the image query leaves it out.
    h.images = [{ id: 10 }, { id: 30 }];
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(cards()).toEqual(['30', '10', 'hidden 20']);
  });

  test('keeps the panel and race so far when the viewer may see none of the flags', async () => {
    h.images = [];
    await renderWithProviders(<FlagRaceEventSection event="birthday2026" />);
    expect(section()).not.toBeNull();
    expect(document.querySelector('[data-testid="panel"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="totals"]')).not.toBeNull();
    expect(cards()).toEqual(['hidden 30', 'hidden 10', 'hidden 20']);
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
