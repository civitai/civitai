import { page } from '@vitest/browser/context';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../test/component-setup';

import { DepositStatusBadge } from '~/components/Buzz/CryptoDeposit/DepositHistory';

describe('DepositStatusBadge', () => {
  it.each(['confirming', 'confirmed', 'sending'])(
    'shows a %s deposit as confirming',
    async (status) => {
      renderWithProviders(<DepositStatusBadge status={status} />);
      await expect.element(page.getByText('Confirming', { exact: true })).toBeVisible();
    }
  );

  it('shows a deposit Support paid by hand as credited, not as its raw status', async () => {
    renderWithProviders(<DepositStatusBadge status="hand_paid" />);
    await expect.element(page.getByText('Credited by support', { exact: true })).toBeVisible();
  });
});
