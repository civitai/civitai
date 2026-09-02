import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { ArticleUnpublishedAlert } from './ArticleUnpublishedAlert';
import { articleUnpublishReasons, unpublishReasons } from '~/server/common/moderation-helpers';

describe('ArticleUnpublishedAlert', () => {
  test('does not accuse the author of a violation over a quality take-down', async () => {
    renderWithProviders(<ArticleUnpublishedAlert reason="insufficient-description" />);

    await expect
      .element(page.getByText('This article has been unpublished: Insufficient content'))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(articleUnpublishReasons['insufficient-description'].notificationMessage)
      )
      .toBeInTheDocument();
    expect(page.getByText(/violation/i).elements()).toHaveLength(0);
  });

  test('still names the violation on a policy take-down', async () => {
    renderWithProviders(<ArticleUnpublishedAlert reason="spam" />);

    await expect
      .element(page.getByText(/unpublished due to a Terms of Service violation/i))
      .toBeInTheDocument();
  });

  test('keeps a legacy reason readable without heading it with model vocabulary', async () => {
    renderWithProviders(<ArticleUnpublishedAlert reason="no-posts" />);

    // Await the body first: it renders in both the fixed and the broken variant, so the heading
    // checks below fail in milliseconds rather than timing out waiting for text that never arrives.
    await expect
      .element(page.getByText(unpublishReasons['no-posts'].notificationMessage))
      .toBeInTheDocument();

    // `no-posts` is quality, so the heading must not accuse — but "Missing images" is the MODEL
    // list's label and has no business heading an article's banner.
    expect(
      page.getByText('This article has been unpublished', { exact: true }).elements()
    ).toHaveLength(1);
    expect(page.getByText(/Missing images/).elements()).toHaveLength(0);
  });

  test('shows the support hint only to a non-moderator', async () => {
    const { rerender } = await renderWithProviders(
      <ArticleUnpublishedAlert reason="spam" showSupportHint />
    );

    await expect.element(page.getByText(/please contact support/i)).toBeInTheDocument();

    await rerender(<ArticleUnpublishedAlert reason="spam" />);

    await expect.element(page.getByText(/Terms of Service violation/i)).toBeInTheDocument();
    expect(page.getByText(/please contact support/i).elements()).toHaveLength(0);
  });
});
