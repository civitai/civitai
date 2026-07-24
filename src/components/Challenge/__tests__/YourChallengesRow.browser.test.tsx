import type React from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The band is personal: it must be completely absent (no header, no skeleton) for
// logged-out users, while the query is in flight, and when the user has no challenges —
// otherwise a titled "Your Challenges" band flashes at every first-time visitor.

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  currentUser: { current: null as { id: number } | null },
}));

vi.mock('~/utils/trpc', () => ({
  trpc: { challenge: { getMyChallenges: { useQuery: mocks.useQuery } } },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser.current,
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

vi.mock('~/components/Cards/MyChallengeCard', () => ({
  MyChallengeCard: ({ data }: { data: { title: string } }) => (
    <div data-testid="my-challenge-card">{data.title}</div>
  ),
}));

import { YourChallengesRow } from '~/components/Challenge/YourChallengesRow';

const queryResult = (data: unknown, isLoading = false) => ({ data, isLoading, isRefetching: false });

describe('YourChallengesRow', () => {
  beforeEach(() => {
    mocks.useQuery.mockReset();
    mocks.currentUser.current = { id: 1 };
  });

  test('renders nothing when logged out', async () => {
    mocks.currentUser.current = null;
    mocks.useQuery.mockReturnValue(queryResult(undefined, true));
    await renderWithProviders(<YourChallengesRow />);
    await expect.element(page.getByText('Your Challenges')).not.toBeInTheDocument();
  });

  test('renders nothing while loading', async () => {
    mocks.useQuery.mockReturnValue(queryResult(undefined, true));
    await renderWithProviders(<YourChallengesRow />);
    await expect.element(page.getByText('Your Challenges')).not.toBeInTheDocument();
  });

  test('renders nothing when the user has no challenges', async () => {
    mocks.useQuery.mockReturnValue(queryResult([]));
    await renderWithProviders(<YourChallengesRow />);
    await expect.element(page.getByText('Your Challenges')).not.toBeInTheDocument();
  });

  test('renders the header, See all link, and a card per challenge', async () => {
    mocks.useQuery.mockReturnValue(
      queryResult([
        { id: 7, title: 'Neon Cats', myResult: 'entered' },
        { id: 8, title: 'Foggy Forests', myResult: 'hosting' },
      ])
    );
    await renderWithProviders(<YourChallengesRow />);
    await expect.element(page.getByText('Your Challenges')).toBeInTheDocument();
    await expect.element(page.getByText('Neon Cats')).toBeInTheDocument();
    await expect.element(page.getByText('Foggy Forests')).toBeInTheDocument();
    await expect
      .element(page.getByRole('link', { name: /see all/i }))
      .toHaveAttribute('href', '/challenges?engagement=participated');
  });

  test('See all links to Created when the row is entirely hosted challenges', async () => {
    mocks.useQuery.mockReturnValue(
      queryResult([
        { id: 7, title: 'Neon Cats', myResult: 'hosting' },
        { id: 8, title: 'Foggy Forests', myResult: 'hosting' },
      ])
    );
    await renderWithProviders(<YourChallengesRow />);
    await expect
      .element(page.getByRole('link', { name: /see all/i }))
      .toHaveAttribute('href', '/challenges?engagement=created');
  });

  test('the subtitle covers both entered and created challenges', async () => {
    mocks.useQuery.mockReturnValue(queryResult([{ id: 7, title: 'Neon Cats' }]));
    await renderWithProviders(<YourChallengesRow />);
    await expect
      .element(page.getByText("Challenges you've entered or created"))
      .toBeInTheDocument();
  });
});
