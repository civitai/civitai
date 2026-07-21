import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { EventHero } from '~/components/Challenge/EventHero';

const base = {
  id: 7,
  title: 'Creator Showcase',
  description: 'Featured event spotlighting standout creators',
  titleColor: 'green',
  startDate: new Date('2026-07-01'),
  coverImage: null,
  challenges: [],
  challengeCount: 6,
} as any;

const future = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

describe('EventHero', () => {
  test('renders title, challenge-count label, and a back link to /challenges', async () => {
    renderWithProviders(<EventHero event={{ ...base, active: true, endDate: future }} />);
    await expect.element(page.getByText('Creator Showcase')).toBeInTheDocument();
    await expect.element(page.getByText('Challenges')).toBeInTheDocument();
    await expect.element(page.getByRole('link')).toHaveAttribute('href', '/challenges');
  });

  test('shows Active Event for a live event', async () => {
    renderWithProviders(<EventHero event={{ ...base, active: true, endDate: future }} />);
    await expect.element(page.getByText('Active Event')).toBeInTheDocument();
  });

  test('shows Event Ended for a past event', async () => {
    renderWithProviders(<EventHero event={{ ...base, active: true, endDate: past }} />);
    await expect.element(page.getByText('Event Ended')).toBeInTheDocument();
  });
});
