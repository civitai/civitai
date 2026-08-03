import type React from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// Pins the 0 / 1 / >1 branch: nothing, a bare banner, or a carousel of banners.
// Embla is stubbed to a marker element so "did we take the carousel branch?" is
// directly observable without depending on the real carousel's measurements.

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));

// EdgeMedia (reached through EventBannerCard) pulls the batching helpers out of
// this module, so the stub has to keep them alongside the `trpc` client itself.
vi.mock('~/utils/trpc', () => ({
  trpc: { challenge: { getActiveEvents: { useQuery: mocks.useQuery } } },
  setTrpcBatchingEnabled: vi.fn(),
  getTrpcBatchingEnabled: vi.fn(() => true),
}));

vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({
    items: data,
    loadingPreferences: false,
  }),
}));

// SectionBand renders a MasonryContainer, which needs the masonry context this
// harness doesn't provide. The band wrapper isn't what these tests are about.
vi.mock('~/components/Challenge/SectionBand', () => ({
  SectionBand: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('~/components/EmblaCarousel/EmblaCarousel', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Embla = Object.assign(
    ({ children }: { children?: React.ReactNode }) => <div data-testid="embla">{children}</div>,
    { Viewport: Passthrough, Container: Passthrough, Slide: Passthrough }
  );
  return { Embla };
});

import { FeaturedChallengeEvents } from '~/components/Challenge/FeaturedChallengeEvents';

const makeEvent = (id: number, challengeCount: number) => ({
  id,
  title: `Event ${id}`,
  description: null,
  titleColor: 'purple',
  startDate: new Date('2026-07-01'),
  endDate: new Date('2026-08-31'),
  coverImage: null,
  challenges: Array.from({ length: challengeCount }, (_, i) => ({ id: id * 100 + i })),
});

const queryResult = (data: unknown, isLoading = false) => ({ data, isLoading, isRefetching: false });

describe('FeaturedChallengeEvents', () => {
  beforeEach(() => mocks.useQuery.mockReset());

  test('renders nothing while loading', async () => {
    mocks.useQuery.mockReturnValue(queryResult(undefined, true));
    await renderWithProviders(<FeaturedChallengeEvents />);
    await expect.element(page.getByTestId('embla')).not.toBeInTheDocument();
    await expect.element(page.getByRole('link')).not.toBeInTheDocument();
  });

  test('renders nothing when there are no active events', async () => {
    mocks.useQuery.mockReturnValue(queryResult([]));
    await renderWithProviders(<FeaturedChallengeEvents />);
    await expect.element(page.getByRole('link')).not.toBeInTheDocument();
  });

  test('renders a single banner without a carousel', async () => {
    mocks.useQuery.mockReturnValue(queryResult([makeEvent(1, 2)]));
    await renderWithProviders(<FeaturedChallengeEvents />);
    await expect.element(page.getByText('Event 1')).toBeInTheDocument();
    await expect.element(page.getByTestId('embla')).not.toBeInTheDocument();
  });

  test('renders a carousel when there is more than one event', async () => {
    mocks.useQuery.mockReturnValue(queryResult([makeEvent(1, 2), makeEvent(2, 1)]));
    await renderWithProviders(<FeaturedChallengeEvents />);
    await expect.element(page.getByTestId('embla')).toBeInTheDocument();
    await expect.element(page.getByText('Event 1')).toBeInTheDocument();
    await expect.element(page.getByText('Event 2')).toBeInTheDocument();
  });

  test('drops events whose challenges are all hidden by preferences', async () => {
    mocks.useQuery.mockReturnValue(queryResult([makeEvent(1, 0)]));
    await renderWithProviders(<FeaturedChallengeEvents />);
    await expect.element(page.getByRole('link')).not.toBeInTheDocument();
  });
});
