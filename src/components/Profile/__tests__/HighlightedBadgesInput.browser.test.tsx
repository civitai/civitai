import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { HighlightedBadgesInput } from '~/components/Profile/HighlightedBadgesInput';

/**
 * A pinned badge the user no longer owns has no tile, so it must not take a pin number:
 * the numbers on the visible tiles stay 1, 2, 3.
 */
const badges = [
  { id: 1, name: 'One' },
  { id: 2, name: 'Two' },
  { id: 3, name: 'Three' },
];

describe('HighlightedBadgesInput', () => {
  test('numbers pins consecutively when a saved id is no longer owned', async () => {
    // 99 is saved between two owned badges but has no tile.
    await renderWithProviders(
      <HighlightedBadgesInput badges={badges} value={[1, 99, 2, 3]} onChange={vi.fn()} />
    );
    await expect.element(page.getByText('1', { exact: true })).toBeVisible();
    await expect.element(page.getByText('2', { exact: true })).toBeVisible();
    await expect.element(page.getByText('3', { exact: true })).toBeVisible();
    await expect.element(page.getByText('4', { exact: true })).not.toBeInTheDocument();
  });
});
