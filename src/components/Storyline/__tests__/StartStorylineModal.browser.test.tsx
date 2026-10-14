import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as DialogProviderMod from '~/components/Dialog/DialogProvider';
import { NsfwLevel } from '~/server/common/enums';
import { StartStorylineModal } from '~/components/Storyline/StartStorylineModal';

/**
 * The start form sends the post, the title and the ceiling the creator chose, and refuses a ceiling
 * below chapter 1's own rating: a storyline whose first chapter is above its ceiling would hide its
 * own start.
 */

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.create': {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
    }),
  };
});

vi.mock('~/components/Dialog/DialogProvider', async (orig) => ({
  ...(await orig<typeof DialogProviderMod>()),
  useDialogContext: () => ({ opened: true, onClose: vi.fn(), zIndex: 200 }),
}));

beforeEach(() => mocks.mutate.mockReset());

describe('StartStorylineModal', () => {
  test('starts the storyline from the post, at chapter 1 rating or above', async () => {
    renderWithProviders(
      <StartStorylineModal postId={41} postTitle="Cat patch" postNsfwLevel={NsfwLevel.R} />
    );

    await expect.element(page.getByRole('radio', { name: 'PG', exact: true })).toBeDisabled();
    await expect.element(page.getByRole('radio', { name: 'PG-13', exact: true })).toBeDisabled();
    await expect.element(page.getByRole('radio', { name: 'R', exact: true })).toBeChecked();
    await expect.element(page.getByRole('radio', { name: 'X', exact: true })).toBeEnabled();

    await page.getByRole('textbox', { name: 'Title' }).fill('  The Patch  ');
    await page.getByText('X', { exact: true }).click();
    await page.getByRole('button', { name: 'Start storyline' }).click();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({
      postId: 41,
      title: 'The Patch',
      maxNsfwLevel: NsfwLevel.X,
    });
  });

  // A post's level is the OR of its images', so it is judged by its most severe image.
  test('a post with PG and R images is judged as R', async () => {
    renderWithProviders(
      <StartStorylineModal postId={41} postNsfwLevel={NsfwLevel.PG | NsfwLevel.R} />
    );

    await expect.element(page.getByRole('radio', { name: 'PG-13', exact: true })).toBeDisabled();
    await expect.element(page.getByRole('radio', { name: 'R', exact: true })).toBeChecked();
  });

  test('a title of only spaces cannot start one', async () => {
    renderWithProviders(<StartStorylineModal postId={41} postNsfwLevel={NsfwLevel.PG} />);

    await page.getByRole('textbox', { name: 'Title' }).fill('   ');
    await expect.element(page.getByRole('button', { name: 'Start storyline' })).toBeDisabled();
  });

  test('a PG post defaults the ceiling to PG-13', async () => {
    renderWithProviders(<StartStorylineModal postId={7} postNsfwLevel={NsfwLevel.PG} />);

    await expect.element(page.getByRole('radio', { name: 'PG-13', exact: true })).toBeChecked();
    await expect.element(page.getByRole('radio', { name: 'PG', exact: true })).toBeEnabled();
  });

  test('an unrated post cannot start one yet', async () => {
    renderWithProviders(<StartStorylineModal postId={7} postTitle="Draft" postNsfwLevel={0} />);

    await expect
      .element(page.getByText("This post hasn't been rated yet.", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start storyline' })).toBeDisabled();
  });
});
