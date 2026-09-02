import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { ArticleUnpublishedAlert } from './ArticleUnpublishedAlert';
import {
  articleUnpublishReasons,
  legacyArticleUnpublishReasons,
} from '~/server/common/moderation-helpers';

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

  test('gives a legacy reason article wording rather than the model copy', async () => {
    renderWithProviders(<ArticleUnpublishedAlert reason="no-posts" />);

    await expect
      .element(page.getByText(legacyArticleUnpublishReasons['no-posts'].notificationMessage))
      .toBeInTheDocument();
    expect(page.getByText(/\bmodel\b/i).elements()).toHaveLength(0);
  });

  test('neither accuses nor invents a reason for a key it has no copy for', async () => {
    renderWithProviders(<ArticleUnpublishedAlert reason="retired-reason" />);

    // Await only the heading prefix, which both the fixed and the broken variant render. Everything
    // that discriminates them is then read synchronously, so a regression fails in milliseconds
    // instead of polling out the 15s browser timeout.
    await expect.element(page.getByText(/This article has been unpublished/)).toBeInTheDocument();
    expect(
      page.getByText('This article has been unpublished', { exact: true }).elements()
    ).toHaveLength(1);
    expect(page.getByText('A moderator unpublished this article.').elements()).toHaveLength(1);
    expect(page.getByText(/violation/i).elements()).toHaveLength(0);
  });

  test('keeps the moderator note to the reason it was written for', async () => {
    const { rerender } = await renderWithProviders(
      <ArticleUnpublishedAlert reason="other" customMessage="Written assuming it stays internal" />
    );

    await expect
      .element(page.getByText(/Written assuming it stays internal/))
      .toBeInTheDocument();

    await rerender(
      <ArticleUnpublishedAlert reason="spam" customMessage="Written assuming it stays internal" />
    );

    await expect.element(page.getByText(articleUnpublishReasons.spam.notificationMessage)).toBeInTheDocument();
    expect(page.getByText(/Written assuming it stays internal/).elements()).toHaveLength(0);
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
