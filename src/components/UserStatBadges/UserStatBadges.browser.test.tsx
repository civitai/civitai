import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { UserStatBadgesV2 } from './UserStatBadges';

const waitForBadgeImagesToFail = async () => {
  await expect
    .poll(() => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('img[src*="base-badge"]')];
      return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth === 0);
    })
    .toBe(true);
};

describe('UserStatBadgesV2 when the badge image fails to load', () => {
  test('does not paint the stat label as broken-image alt text', async () => {
    await renderWithProviders(<UserStatBadgesV2 stats={{ followers: 390, likes: 400 }} />);
    await waitForBadgeImagesToFail();

    for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="base-badge"]')) {
      expect(img.alt).toBe('');
    }
  });

  test('keeps the label and value as the accessible name of each pill', async () => {
    await renderWithProviders(<UserStatBadgesV2 stats={{ followers: 390, likes: 400 }} />);
    await waitForBadgeImagesToFail();

    await expect.element(page.getByRole('img', { name: 'Followers - 390' })).toBeInTheDocument();
    await expect.element(page.getByRole('img', { name: 'Likes - 400' })).toBeInTheDocument();
  });
});
