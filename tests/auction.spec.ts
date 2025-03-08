import { test } from '@playwright/test';
import { authDegen } from './auth/data';

test.describe('bidding', () => {
  test.use(authDegen);

  test('bid first', async ({ page }) => {
    await page.goto('/auctions');

    await page.getByRole('button', { name: 'Select model' }).click();

    const confirmBtn = page.getByRole('button', { name: 'Close' });
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    await page.getByText('ALL', { exact: true }).click();
    await page.locator('div').getByRole('button', { name: 'Select' }).first().click();
    // TODO get name here...

    await page.getByRole('button', { name: '1st' }).click();
    await page.getByTestId('place-bid-button').click();

    // TODO insert name, make sure it's the first item
    // await expect(page.getByText('1FrugalGovernanceV08,546 1 Bid')).toBeVisible();
  });
});
