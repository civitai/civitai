import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as DialogProviderMod from '~/components/Dialog/DialogProvider';
import type * as ImageUtilsMod from '~/components/Image/image.utils';
import { NsfwLevel } from '~/server/common/enums';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  StartStorylineModal,
  openStartStorylineModal,
} from '~/components/Storyline/StartStorylineModal';

/**
 * The ceiling cannot go below chapter 1's own rating: that storyline would hide its own start (the
 * rule is in StartStorylineModal.tsx).
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  onClose: vi.fn(),
  options: {} as { onSuccess?: (data: { id: number }) => Promise<void> },
  imageQuery: vi.fn(),
  images: [] as unknown[],
  imagesLoading: false,
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

vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtilsMod>()),
  useQueryImages: (input: unknown, options: unknown) => {
    mocks.imageQuery(input, options);
    return { images: mocks.images, isLoading: mocks.imagesLoading };
  },
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({
  StorylineThumb: ({
    image,
    ratio,
  }: {
    image: { url: string } | null | undefined;
    ratio?: string;
  }) => (
    <div
      data-testid="thumb"
      data-image={image === undefined ? 'loading' : image?.url ?? 'none'}
      data-ratio={ratio ?? '3/4'}
    />
  ),
}));

vi.mock('~/components/Dialog/DialogProvider', async (orig) => ({
  ...(await orig<typeof DialogProviderMod>()),
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose, zIndex: 200 }),
}));

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.onClose.mockReset();
  mocks.imageQuery.mockReset();
  mocks.images = [{ id: 5, url: 'first-of-41', type: 'image', nsfwLevel: 1 }];
  mocks.imagesLoading = false;
  vi.mocked(useRouter().push).mockClear();
});

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
    await page.getByText('Only collaborators').click();
    await page.getByRole('button', { name: 'Start storyline' }).click();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({
      postId: 41,
      title: 'The Patch',
      maxNsfwLevel: NsfwLevel.X,
      whoCanContinue: 'Collaborators',
    });
  });

  test("shows the post's first image as chapter 1 and the cover", async () => {
    renderWithProviders(<StartStorylineModal postId={41} postNsfwLevel={NsfwLevel.PG} />);

    const cover = page.getByTestId('storyline-start-cover');
    await expect.element(cover).toHaveTextContent('Chapter 1 and the cover');
    const thumb = cover.getByTestId('thumb').element();
    expect(thumb.getAttribute('data-image')).toBe('first-of-41');
    expect(thumb.getAttribute('data-ratio')).toBe('4/5');
    expect(mocks.imageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ postId: 41, limit: 1 }),
      { enabled: true }
    );
  });

  test('the cover is loading until the image read answers, then none if it found none', async () => {
    mocks.imagesLoading = true;
    const first = await renderWithProviders(
      <StartStorylineModal postId={41} postNsfwLevel={NsfwLevel.PG} />
    );
    await expect
      .element(page.getByTestId('storyline-start-cover').getByTestId('thumb'))
      .toHaveAttribute('data-image', 'loading');
    await first.unmount();

    mocks.imagesLoading = false;
    mocks.images = [];
    renderWithProviders(<StartStorylineModal postId={41} postNsfwLevel={NsfwLevel.PG} />);
    await expect
      .element(page.getByTestId('storyline-start-cover').getByTestId('thumb'))
      .toHaveAttribute('data-image', 'none');
  });

  test('the chips say it is free and who reviews, following the choice', async () => {
    renderWithProviders(<StartStorylineModal postId={41} postNsfwLevel={NsfwLevel.PG} />);

    const terms = page.getByTestId('storyline-start-terms');
    await expect.element(terms).toHaveTextContent(/^Free to continueAnyone · you review$/);
    await page.getByText('Only collaborators').click();
    await expect.element(terms).toHaveTextContent(/^Free to continueCollaborators only$/);
  });

  test('anyone can continue unless the creator says otherwise', async () => {
    renderWithProviders(<StartStorylineModal postId={41} postNsfwLevel={NsfwLevel.PG} />);

    await page.getByRole('textbox', { name: 'Title' }).fill('The Patch');
    await page.getByRole('button', { name: 'Start storyline' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ whoCanContinue: 'Anyone' })
    );
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

  test('once created, closes and opens the new storyline', async () => {
    renderWithProviders(<StartStorylineModal postId={41} postNsfwLevel={NsfwLevel.PG} />);
    await expect.element(page.getByRole('button', { name: 'Start storyline' })).toBeVisible();

    await mocks.options.onSuccess?.({ id: 9 });
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
    // The router is the shared component-setup stub.
    expect(useRouter().push).toHaveBeenCalledWith('/storylines/9');
  });

  test('the opener hands the form the post it was opened from', () => {
    const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
    openStartStorylineModal({ id: 41, title: 'Cat patch', nsfwLevel: NsfwLevel.R });

    expect(trigger).toHaveBeenCalledWith({
      component: StartStorylineModal,
      props: { postId: 41, postTitle: 'Cat patch', postNsfwLevel: NsfwLevel.R },
    });
    trigger.mockRestore();
  });
});
