import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `ReviewerNotesButton` — reviewer notes open in a modal instead of rendering inline. Whether
 * to render the button at all is the caller's call (`OffsiteSubmissionsList`'s suite).
 */

const { ReviewerNotesButton } = await import('./ReviewerNotesButton');

describe('ReviewerNotesButton', () => {
  test('approval notes are NOT inline; the button opens a modal with them', async () => {
    const notes = 'Please tighten the manifest scopes before next version.';
    renderWithProviders(<ReviewerNotesButton notes={notes} variant="approved" />);
    expect(page.getByText(notes, { exact: false }).elements()).toHaveLength(0);
    const btn = page.getByRole('button', { name: /see reviewer notes/i });
    await expect.element(btn).toBeInTheDocument();
    await btn.click();
    await expect.element(page.getByText(notes, { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('Reviewer notes', { exact: true })).toBeInTheDocument();
  });

  test('a rejection reason opens under the "Reviewer feedback" title', async () => {
    const reason = 'Rejected: the block requests an unapproved scope.';
    renderWithProviders(<ReviewerNotesButton notes={reason} variant="rejected" />);
    expect(page.getByText(reason, { exact: false }).elements()).toHaveLength(0);
    await page.getByRole('button', { name: /see reviewer notes/i }).click();
    await expect.element(page.getByText(reason, { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('Reviewer feedback', { exact: true })).toBeInTheDocument();
  });
});
