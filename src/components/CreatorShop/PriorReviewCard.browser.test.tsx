import React from 'react';
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { PriorReviewCard } from '~/components/CreatorShop/PriorReviewCard';
import type { PriorReview } from '~/components/CreatorShop/review-history';

const PRIOR: PriorReview = {
  action: 'request-changes',
  note: 'Visual quality - your badge is very very tiny',
  at: '2026-08-11T23:28:00.000Z',
  reviewerId: 99,
  artworkSwaps: 0,
  editedFields: [],
};

// Scoped to this mount's container, so a second render inside one test can't be
// matched by the first one's locator.
async function renderCard(prior: PriorReview) {
  const { container } = await renderWithProviders(<PriorReviewCard prior={prior} />);
  return { container, within: page.elementLocator(container) };
}

describe('PriorReviewCard', () => {
  test('shows the previous verdict and the note the last reviewer left', async () => {
    const { within } = await renderCard(PRIOR);
    await expect.element(within.getByText(/previously: changes requested/i)).toBeInTheDocument();
    await expect.element(within.getByText(PRIOR.note as string)).toBeInTheDocument();
  });

  test('warns that the artwork was replaced since, and does not when it was not', async () => {
    const swapped = await renderCard({ ...PRIOR, artworkSwaps: 2 });
    await expect
      .element(swapped.within.getByText(/artwork replaced 2 times since/i))
      .toBeInTheDocument();

    // Negative control: the same card with no swaps must not claim any.
    const unswapped = await renderCard(PRIOR);
    expect(unswapped.container.textContent).not.toMatch(/artwork replaced/i);
  });

  test('names the other fields moved since the verdict', async () => {
    const { container } = await renderCard({ ...PRIOR, editedFields: ['price', 'quantity'] });
    expect(container.textContent).toContain('Also changed since: Price, Quantity');
  });
});
