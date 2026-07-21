import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { EventBannerCard } from '~/components/Challenge/EventBannerCard';
import type { ChallengeEventListItem } from '~/server/schema/challenge.schema';

const event = {
  id: 42,
  title: 'Civitai Summer Art Festival',
  description: 'Compete all summer',
  titleColor: 'purple',
  startDate: new Date('2026-07-01'),
  endDate: new Date('2026-08-31'),
  coverImage: null,
  challenges: [{ id: 1 }, { id: 2 }, { id: 3 }] as unknown as ChallengeEventListItem['challenges'],
} satisfies ChallengeEventListItem;

describe('EventBannerCard', () => {
  test('renders the title and links to the event page', async () => {
    renderWithProviders(<EventBannerCard event={event} />);
    await expect.element(page.getByText('Civitai Summer Art Festival')).toBeInTheDocument();
    await expect.element(page.getByRole('link')).toHaveAttribute('href', '/challenges/events/42');
  });

  test('shows the challenge count', async () => {
    renderWithProviders(<EventBannerCard event={event} />);
    await expect.element(page.getByText(/3 challenges/i)).toBeInTheDocument();
  });
});
