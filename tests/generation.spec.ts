import { expect, Page, test } from '@playwright/test';
import { authDegen, testAuthData } from './auth/data';
import { getImageWhatIfReturn } from './responses/getImageWhatIf';
import { queryGeneratedImagesReturn } from './responses/queryGeneratedImages';

test.describe('generation', () => {
  test.use(authDegen);

  // test.beforeEach(async ({ page }) => {
  const openGen = async ({
    page,
    mockQueryImages = true,
    mockWhatIf = true,
  }: {
    page: Page;
    mockQueryImages?: boolean;
    mockWhatIf?: boolean;
  }) => {
    if (mockQueryImages) {
      await page.route(/\/api\/trpc\/orchestrator.queryGeneratedImages(\?|$)/, async (route) => {
        await route.fulfill({ json: queryGeneratedImagesReturn });
      });
    }
    if (mockWhatIf) {
      await page.route(/\/api\/trpc\/orchestrator.getImageWhatIf(\?|$)/, async (route) => {
        await route.fulfill({ json: getImageWhatIfReturn });
      });
    }

    await page.goto('/');
    await page.getByRole('button').filter({ hasText: 'Create' }).click();

    const tourSkip = page.getByRole('button', { name: 'Skip' });
    if (await tourSkip.isVisible()) {
      await tourSkip.click();
    }

    const confirmBtn = page.getByRole('button', { name: 'I Confirm, Start Generating' });
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    // trying to save the localstorage state
    await page.context().storageState({ path: testAuthData.degen.path });
  };

  test('check feed count', async ({ page }) => {
    await openGen({ page });

    // this is the queue button, but I can't seem to add a data-testid without the whole thing breaking
    await page.locator('div:nth-child(4) > .__mantine-ref-label').first().click();

    await expect(page.getByTestId('generation-feed-list').locator('> div')).toHaveCount(19);
  });

  test('swap models', async ({ page }) => {
    await openGen({ page });
    await page.getByRole('button', { name: 'Swap' }).click();
    // await items?
    const firstItem = page.getByTestId('resource-select-items').locator('> div').first();

    const modelName = await firstItem.getByTestId('resource-select-name').innerText();
    console.log(modelName);

    await firstItem.getByRole('button', { name: 'Select' }).click();

    await expect(page.getByTestId('selected-gen-resource-name')).toHaveText(modelName);
  });

  //
});
