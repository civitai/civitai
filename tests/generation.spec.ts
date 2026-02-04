import { expect, Page, test } from '@playwright/test';
import { authDegen, testAuthData } from './auth/data';
import { getImageWhatIfReturn } from './responses/getImageWhatIf';
import { queryGeneratedImagesReturn } from './responses/queryGeneratedImages';
import { parseRequestParams } from './utils';

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
      await page.route(/\/api\/trpc\/orchestrator.whatIfFromGraph(\?|$)/, async (route) => {
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

  const getSwapModel = async (page: Page) => {
    await page.getByRole('button', { name: 'Swap' }).click();

    const confirmBtn = page.getByRole('button', { name: 'Close' });
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    // await items?
    return page.getByTestId('resource-select-items').locator('> div').first();
  };

  test('swap models', async ({ page }) => {
    await openGen({ page });
    const firstItem = await getSwapModel(page);

    const modelName = await firstItem.getByTestId('resource-select-name').innerText();
    expect(modelName.length).toBeGreaterThan(0);

    await firstItem.getByRole('button', { name: 'Select' }).click();

    await expect(page.getByTestId('selected-gen-resource-name')).toHaveText(modelName);
  });

  test('form values reset upon clicking reset button', async ({ page }) => {
    await openGen({ page });

    const firstItem = await getSwapModel(page);
    await firstItem.getByRole('button', { name: 'Select' }).click();

    await page
      .getByRole('textbox', { name: 'Your prompt goes here...' })
      .fill('Test prompt for reset functionality');
    await page.getByRole('textbox', { name: 'Negative Prompt' }).fill('Test negative prompt');

    await page.getByRole('button', { name: 'Advanced' }).click();

    await page.getByText('Creative').click();
    await page.getByTestId('gen-cfg-scale').locator('button').nth(1).click();

    await page.getByRole('searchbox', { name: 'Sampler' }).click();
    await page.getByRole('option', { name: 'Heun' }).click();
    await page.getByTestId('gen-steps').locator('button').nth(2).click();

    const seedInput = page.getByRole('textbox', { name: 'Random' });
    await seedInput.fill('234');

    // Change Quantity
    // const quantityInput = page.getByRole('spinbutton').filter({ hasText: '1' });
    // await quantityInput.click();
    // await quantityInput.fill('4');

    await expect(page.getByRole('textbox', { name: 'Your prompt goes here...' })).toHaveValue(
      'Test prompt for reset functionality'
    );
    await expect(page.getByRole('textbox', { name: 'Negative Prompt' })).toHaveValue(
      'Test negative prompt'
    );
    await expect(seedInput).toHaveValue('234');

    await page.getByRole('button', { name: 'Reset' }).click();

    await expect(page.getByRole('textbox', { name: 'Your prompt goes here...' })).toHaveValue('');
    // await expect(page.getByRole('textbox', { name: 'Negative Prompt' })).toHaveValue('');
    await expect(seedInput).not.toHaveValue('234');
  });

  test('make sure flux-pro-raw is not in other requests', async ({ page }) => {
    await openGen({ page });

    // await page.getByRole('button', { name: 'Reset' }).click();

    await page.getByText('Ultra').click();
    await page.locator('label[for="input_fluxUltraRaw"]').first().click();

    const firstItem = await getSwapModel(page);
    await firstItem.getByRole('button', { name: 'Select' }).click();

    await page
      .getByRole('textbox', { name: 'Your prompt goes here...' })
      .fill('Test prompt for reset functionality');

    await page.route(/\/api\/trpc\/orchestrator.generateFromGraph(\?|$)/, async (route, request) => {
      const params = parseRequestParams(request);
      expect(params).toHaveProperty('engine', null); // or not be there
      await route.fulfill({ json: {} });
    });

    await page.getByRole('button', { name: 'Generate' }).click();
  });
});
