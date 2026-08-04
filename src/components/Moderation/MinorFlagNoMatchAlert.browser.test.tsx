import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { MinorFlagNoMatchAlert } from '~/components/Moderation/MinorFlagNoMatchAlert';

describe('MinorFlagNoMatchAlert', () => {
  // Most Review-requested rows are a moderator's own Set-as-Minor, which never had
  // a hash match — telling that moderator the evidence has since vanished invents a
  // reason to doubt a decision that was made without hashes in the first place.
  test('a manually flagged model is not described as having lost its evidence', async () => {
    renderWithProviders(<MinorFlagNoMatchAlert flagSource="manual" />);

    await expect.element(page.getByText(/no hash match/i)).toBeVisible();
    expect(document.body.textContent).not.toContain('permanently deleted');
  });

  test('an auto-flagged model still explains that the match no longer resolves', async () => {
    renderWithProviders(<MinorFlagNoMatchAlert flagSource="auto" />);

    await expect.element(page.getByText(/permanently deleted/)).toBeVisible();
  });
});
