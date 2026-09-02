import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { ModelUnpublishedAlert } from './ModelUnpublishedAlert';
import { unpublishReasons } from '~/server/common/moderation-helpers';

describe('ModelUnpublishedAlert', () => {
  test('does not accuse the owner of a violation over a quality take-down', async () => {
    renderWithProviders(<ModelUnpublishedAlert reason="insufficient-description" />);

    await expect
      .element(page.getByText(unpublishReasons['insufficient-description'].notificationMessage))
      .toBeInTheDocument();
    expect(page.getByText(/violation/i).elements()).toHaveLength(0);
    expect(page.getByRole('link', { name: /guidelines/i }).elements()).toHaveLength(0);
  });

  test('still names the violation on a policy take-down', async () => {
    renderWithProviders(<ModelUnpublishedAlert reason="spam" />);

    await expect.element(page.getByText(/violation of our/i)).toBeInTheDocument();
    await expect
      .element(page.getByText(unpublishReasons.spam.notificationMessage))
      .toBeInTheDocument();
  });

  test('falls back to the moderator’s own words when the reason is "other"', async () => {
    renderWithProviders(<ModelUnpublishedAlert reason="other" customMessage="Reposted asset" />);

    await expect.element(page.getByText(/Removal reason: Reposted asset/)).toBeInTheDocument();
  });

  test('offers the appeal link only where the caller asks for it', async () => {
    const { rerender } = await renderWithProviders(<ModelUnpublishedAlert reason="spam" />);

    await expect.element(page.getByText(/violation of our/i)).toBeInTheDocument();
    expect(page.getByRole('link', { name: /submit an appeal/i }).elements()).toHaveLength(0);

    await rerender(<ModelUnpublishedAlert reason="spam" showAppeal />);

    await expect.element(page.getByRole('link', { name: /submit an appeal/i })).toBeInTheDocument();
  });
});
