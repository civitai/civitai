import { expect, Locator, Page, test } from '@playwright/test';
import { authDegen, authMod } from './auth/data';
import { queryGeneratedImagesReturn } from './responses/queryGeneratedImages';
import { apiResp } from './utils';

test('404', async ({ page }) => {
  // test 404 page
  await page.goto('/asdf');
  await expect(page.getByText('page could not be found')).toBeVisible();
});

test('no login', async ({ page }) => {
  // test redirect on no login
  await page.goto('/user/account');
  await expect(page).toHaveURL('/');
});

test.describe('examples', () => {
  test.use(authMod);

  test('validate mod user', async ({ page }) => {
    await page.goto('/user/account');
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('test-mod');
  });

  test('chat button', async ({ page, isMobile }) => {
    // picking a low impact page
    await page.goto('/content/privacy');
    // note - this has exposed an issue, if you click the button before "something" happens, the chat window does not show up sometimes
    await page.waitForResponse(
      (resp) => resp.url().includes('/api/trpc/chat.getUnreadCount') && resp.status() === 200
    );
    // there are two buttons due to media queries
    const btn = page.getByTestId('open-chat').locator('visible=true');
    await btn.click();

    // for localstorage changes, we could inspect or manually set the storage here
    const confirmBtn = page.getByRole('button', { name: 'Got it' });
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    // mobile view differs
    const locator = isMobile
      ? page.getByText('Chats', { exact: true })
      : page.getByText('New Chat');

    // toggle chat window and check visibility
    await expect(locator).toBeVisible();
    await btn.click();
    await expect(locator).not.toBeVisible();
  });
});

test.describe('comments', () => {
  test.use(authDegen);

  test('comment chain', async ({ page }) => {
    const text =
      'testing long comment replies. this is a test of someone saying something, and then eventually responding to it.';

    // Helper function to post a comment or reply
    const postComment = async (loc: Locator | Page, isReply: boolean) => {
      if (isReply) {
        await loc.getByRole('button', { name: 'Reply' }).click();
      } else {
        await loc.getByTestId('comment-form').click();
      }
      // TODO there is a delay here, sometimes cutting off the first letter
      // await page.keyboard.type(text);
      await loc.getByTestId('comment-form').locator('div').nth(2).fill(text);

      // avoid race condition for clicking and awaiting response
      const [response] = await Promise.all([
        page.waitForResponse(
          (resp) => resp.url().includes('/api/trpc/commentv2.upsert') && resp.status() === 200
        ),
        loc.getByRole('button', { name: 'Comment' }).click(),
      ]);

      // get the id in the response, and check the value in the relevant field
      const json = await response.json();
      const commentId = json?.result?.data?.json?.id;
      expect(commentId).toBeGreaterThan(0);
      const newLoc = page.locator(`#comment-${commentId}`);
      await expect(newLoc.getByRole('paragraph')).toHaveText(text);
      return newLoc;
    };

    await page.goto('/images/1');

    // Post initial comment
    const commentLoc = await postComment(page, false);

    // replies
    const commentLoc2 = await postComment(commentLoc, true);
    const commentLoc3 = await postComment(commentLoc2, true);
    const commentLoc4 = await postComment(commentLoc3, true);
    const commentLoc5 = await postComment(commentLoc4, true);

    await expect(commentLoc5).toBeInViewport();
  });
});

test.describe('generation', () => {
  test.use(authDegen);

  test('mock generation', async ({ page }) => {
    // override orchestrator calls with custom response
    await page.route(/\/api\/trpc\/orchestrator.queryGeneratedImages(\?|$)/, async (route) => {
      await route.fulfill({ json: queryGeneratedImagesReturn });
    });

    await page.goto('/articles/1');
    await page.getByRole('button').filter({ hasText: 'Create' }).click();

    const confirmBtn = page.getByRole('button', { name: 'I Confirm, Start Generating' });
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    // this is the queue button, but i can't seem to add a data-testid without the whole thing breaking
    await page.locator('div:nth-child(4) > .__mantine-ref-label').first().click();

    await expect(page.getByTestId('generation-feed-list').locator('> div')).toHaveCount(19);
  });
});

test.describe('error handling', () => {
  test.use(authDegen);

  test('error uploading model', async ({ page }) => {
    await page.route('/api/trpc/tag.getAll*', async (route) => {
      await route.fulfill({
        json: apiResp({
          items: [
            {
              id: 1,
              name: 'stuff',
              isCategory: true,
            },
          ],
        }),
      });
    });

    await page.goto('/models/create');

    // test invalid form
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('form')).toContainText('Required');
    await expect(page.getByText('Cannot be empty', { exact: true })).toBeVisible();

    await page.getByRole('textbox', { name: 'Name' }).fill('xyz');
    await page.getByText('Trained', { exact: true }).click();
    await page.getByRole('searchbox', { name: 'Category' }).click();
    await page.getByRole('option', { name: 'Stuff' }).click();
    await page.locator('.ProseMirror').fill('qwd');
    await page.getByRole('radio', { name: 'No' }).check();
    await page.getByRole('checkbox', { name: 'I acknowledge that I have' }).check();

    await page.route('/api/trpc/model.upsert', async (route) => {
      await route.fulfill({
        json: {
          error: {
            json: {
              message: 'bad stuff.',
              code: -32600,
              data: {
                code: 'BAD_REQUEST',
                httpStatus: 400,
                path: 'model.upsert',
              },
            },
          },
        },
        status: 400,
      });
    });

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Failed to save model')).toBeVisible();

    await page.unroute('/api/trpc/model.upsert');

    await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/api/trpc/model.upsert') && resp.status() === 200
      ),
      page.getByRole('button', { name: 'Next' }).click(),
    ]);

    await expect(page.getByRole('heading', { name: 'Add version' })).toBeVisible();
  });
});
