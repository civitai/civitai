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
    // 99 is saved between two owned badges but has no tile. Pick order differs from tile order.
    await renderWithProviders(
      <HighlightedBadgesInput badges={badges} value={[3, 99, 1, 2]} onChange={vi.fn()} />
    );
    await expect.element(page.getByRole('button', { name: 'Three' })).toHaveTextContent('1');
    await expect.element(page.getByRole('button', { name: 'One' })).toHaveTextContent('2');
    await expect.element(page.getByRole('button', { name: 'Two' })).toHaveTextContent('3');
  });
});
