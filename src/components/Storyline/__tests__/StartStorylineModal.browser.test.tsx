import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as DialogProviderMod from '~/components/Dialog/DialogProvider';
import { NsfwLevel } from '~/server/common/enums';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  StartStorylineModal,
  openStartStorylineModal,
} from '~/components/Storyline/StartStorylineModal';

/**
 * A storyline starts before any post: the sheet asks for the title and terms, creates it empty,
 * and sends the author to write chapter 1 (see StartStorylineModal.tsx).
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  onClose: vi.fn(),
  options: {} as { onSuccess?: (data: { id: number }) => Promise<void> },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.create': {
        useMutation: (options: typeof mocks.options) => {
          mocks.options = options;
          return { mutate: mocks.mutate, isPending: false };
        },
      },
    }),
  };
});

vi.mock('~/components/Dialog/DialogProvider', async (orig) => ({
  ...(await orig<typeof DialogProviderMod>()),
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose, zIndex: 200 }),
}));

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.onClose.mockReset();
  vi.mocked(useRouter().push).mockClear();
});

describe('StartStorylineModal', () => {
  test('creates an empty storyline: no post, PG-13 and anyone by default', async () => {
    renderWithProviders(<StartStorylineModal />);

    await expect.element(page.getByRole('radio', { name: 'PG-13', exact: true })).toBeChecked();
    await page.getByRole('textbox', { name: 'Title' }).fill('  The Patch  ');
    await page.getByRole('button', { name: 'Start storyline' }).click();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    // toHaveBeenCalledWith compares the whole object: a `postId` key would fail it.
    expect(mocks.mutate).toHaveBeenCalledWith({
      title: 'The Patch',
      maxNsfwLevel: NsfwLevel.PG13,
      whoCanContinue: 'Anyone',
    });
  });

  test('the chosen rating and collaborators-only go through', async () => {
    renderWithProviders(<StartStorylineModal />);

    await page.getByRole('textbox', { name: 'Title' }).fill('The Patch');
    await page.getByText('X', { exact: true }).click();
    await page.getByText('Only collaborators').click();
    await page.getByRole('button', { name: 'Start storyline' }).click();

    expect(mocks.mutate).toHaveBeenCalledWith({
      title: 'The Patch',
      maxNsfwLevel: NsfwLevel.X,
      whoCanContinue: 'Collaborators',
    });
  });

  test('there is no cover to pick: chapter 1 does not exist yet', async () => {
    renderWithProviders(<StartStorylineModal />);

    await expect.element(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
    expect(page.getByTestId('storyline-start-cover').elements()).toHaveLength(0);
  });

  test('the chips say it is free and who reviews, following the choice', async () => {
    renderWithProviders(<StartStorylineModal />);

    const terms = page.getByTestId('storyline-start-terms');
    await expect.element(terms).toHaveTextContent(/^Free to continueAnyone · you review$/);
    await page.getByText('Only collaborators').click();
    await expect.element(terms).toHaveTextContent(/^Free to continueCollaborators only$/);
  });

  test('a title of only spaces cannot start one', async () => {
    renderWithProviders(<StartStorylineModal />);

    await page.getByRole('textbox', { name: 'Title' }).fill('   ');
    await expect.element(page.getByRole('button', { name: 'Start storyline' })).toBeDisabled();
  });

  test('once created, closes and goes to write chapter 1 of the new storyline', async () => {
    renderWithProviders(<StartStorylineModal />);
    await expect.element(page.getByRole('button', { name: 'Start storyline' })).toBeVisible();

    await mocks.options.onSuccess?.({ id: 9 });
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
    // The router is the shared component-setup stub.
    expect(useRouter().push).toHaveBeenCalledWith('/posts/create?storyline=9');
  });

  test('the opener needs no post', () => {
    const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
    openStartStorylineModal();

    expect(trigger).toHaveBeenCalledWith({
      component: StartStorylineModal,
      props: { post: undefined },
    });
    trigger.mockRestore();
  });

  describe('from a published post', () => {
    const post = { id: 41, title: 'Cat patch', nsfwLevel: NsfwLevel.R, publishedAt: new Date() };

    test('makes the post chapter 1, at a ceiling it fits, and opens the new storyline', async () => {
      renderWithProviders(<StartStorylineModal post={post} />);

      await expect.element(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Cat patch');
      // Below the post's rating cannot be picked; the first that fits is the default.
      await expect.element(page.getByRole('radio', { name: 'PG-13', exact: true })).toBeDisabled();
      await expect.element(page.getByRole('radio', { name: 'R', exact: true })).toBeChecked();
      await page.getByRole('button', { name: 'Start storyline' }).click();

      expect(mocks.mutate).toHaveBeenCalledWith({
        postId: 41,
        title: 'Cat patch',
        maxNsfwLevel: NsfwLevel.R,
        whoCanContinue: 'Anyone',
      });
      await mocks.options.onSuccess?.({ id: 9 });
      expect(useRouter().push).toHaveBeenCalledWith('/storylines/9');
    });

    test('an unrated post cannot start one yet', async () => {
      renderWithProviders(<StartStorylineModal post={{ ...post, nsfwLevel: 0 }} />);

      await expect.element(page.getByText(/hasn.t been rated yet/)).toBeVisible();
      expect(page.getByRole('button', { name: 'Start storyline' }).elements()).toHaveLength(0);
    });

    test('the opener passes the post through', () => {
      const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
      openStartStorylineModal(post);

      expect(trigger).toHaveBeenCalledWith({ component: StartStorylineModal, props: { post } });
      trigger.mockRestore();
    });
  });
});
