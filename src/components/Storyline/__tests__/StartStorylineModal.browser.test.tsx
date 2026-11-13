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
  openStartStorylineFromImageModal,
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
  /** What ImageGuard2 decides for this viewer: false = their preferences blur the image. */
  safe: true,
  guarded: [] as { nsfwLevel: number }[],
  userLookups: [] as { id: number; enabled: boolean }[],
}));

vi.mock('~/components/ImageGuard/ImageGuard2', () => ({
  ImageGuard2: ({
    image,
    children,
  }: {
    image: { nsfwLevel: number };
    children: (safe: boolean) => React.ReactNode;
  }) => {
    mocks.guarded.push(image);
    return <>{children(mocks.safe)}</>;
  },
}));
vi.mock('~/components/ImageHash/ImageHash', () => ({
  MediaHash: () => <span data-testid="hash">blurred</span>,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'user.getById': {
        useQuery: (input: { id: number }, options: { enabled: boolean }) => {
          mocks.userLookups.push({ id: input.id, enabled: options.enabled });
          return { data: options.enabled ? { username: 'sculptor' } : undefined };
        },
      },
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
  mocks.safe = true;
  mocks.guarded = [];
  mocks.userLookups = [];
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

    // Blocked is a moderation verdict: refused as unusable, not as "not rated yet".
    test('a post with a Blocked image cannot start one, and Blocked is not named', async () => {
      renderWithProviders(
        <StartStorylineModal post={{ ...post, nsfwLevel: NsfwLevel.R | NsfwLevel.Blocked }} />
      );

      await expect.element(page.getByText(/can't be used in a storyline/)).toBeVisible();
      expect(page.getByText(/Blocked|rated yet/).elements()).toHaveLength(0);
      expect(page.getByRole('button', { name: 'Start storyline' }).elements()).toHaveLength(0);
    });

    test('the opener passes the post through', () => {
      const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
      openStartStorylineModal(post);

      expect(trigger).toHaveBeenCalledWith({ component: StartStorylineModal, props: { post } });
      trigger.mockRestore();
    });
  });

  describe("from someone's image", () => {
    const sparkImage = {
      id: 77,
      url: 'spark.jpg',
      type: 'image' as const,
      nsfwLevel: NsfwLevel.R,
      username: 'painter',
    };

    test("the credit picture follows the viewer's blur preferences", async () => {
      mocks.safe = false;
      renderWithProviders(<StartStorylineModal sparkImage={sparkImage} />);

      const credit = page.getByTestId('storyline-spark-credit');
      await expect.element(credit.getByTestId('hash')).toBeVisible();
      expect(credit.element().querySelector('img')).toBeNull();
      expect(mocks.guarded.length).toBeGreaterThan(0);
      expect(mocks.guarded.every((image) => image.nsfwLevel === NsfwLevel.R)).toBe(true);
    });

    test('the credit picture shows when the viewer sees it unblurred', async () => {
      renderWithProviders(<StartStorylineModal sparkImage={sparkImage} />);

      const credit = page.getByTestId('storyline-spark-credit');
      await expect.element(credit).toBeVisible();
      expect(credit.element().querySelector('img')).not.toBeNull();
      expect(credit.getByTestId('hash').elements()).toHaveLength(0);
    });

    test('names the creator when the image came with only their id', async () => {
      renderWithProviders(
        <StartStorylineModal sparkImage={{ ...sparkImage, username: null, userId: 5 }} />
      );

      await expect
        .element(page.getByTestId('storyline-spark-credit'))
        .toHaveTextContent("Inspired by @sculptor's image");
      expect(mocks.userLookups).toContainEqual({ id: 5, enabled: true });
    });

    test('says "this image" only when the creator is unknown', async () => {
      renderWithProviders(<StartStorylineModal sparkImage={{ ...sparkImage, username: null }} />);

      await expect
        .element(page.getByTestId('storyline-spark-credit'))
        .toHaveTextContent('Inspired by this image');
      expect(mocks.userLookups.length).toBeGreaterThan(0);
      expect(mocks.userLookups.every((lookup) => !lookup.enabled)).toBe(true);
    });

    test('credits the image, floors the rating at it, and sends the author to write chapter 1', async () => {
      renderWithProviders(<StartStorylineModal sparkImage={sparkImage} />);

      await expect
        .element(page.getByTestId('storyline-spark-credit'))
        .toHaveTextContent("Inspired by @painter's image");
      await expect.element(page.getByRole('radio', { name: 'PG-13', exact: true })).toBeDisabled();
      await expect.element(page.getByRole('radio', { name: 'R', exact: true })).toBeChecked();
      await page.getByRole('textbox', { name: 'Title' }).fill('After the painting');
      await page.getByRole('button', { name: 'Start storyline' }).click();

      expect(mocks.mutate).toHaveBeenCalledWith({
        sparkImageId: 77,
        title: 'After the painting',
        maxNsfwLevel: NsfwLevel.R,
        whoCanContinue: 'Anyone',
      });
      expect(mocks.mutate.mock.calls[0][0].postId).toBeUndefined();
      await mocks.options.onSuccess?.({ id: 9 });
      expect(useRouter().push).toHaveBeenCalledWith('/posts/create?storyline=9');
    });

    test('an unrated image cannot start one yet', async () => {
      renderWithProviders(<StartStorylineModal sparkImage={{ ...sparkImage, nsfwLevel: 0 }} />);

      await expect.element(page.getByText(/image hasn.t been rated yet/)).toBeVisible();
      expect(page.getByRole('button', { name: 'Start storyline' }).elements()).toHaveLength(0);
    });

    test('the opener passes the image through', () => {
      const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
      openStartStorylineFromImageModal(sparkImage);

      expect(trigger).toHaveBeenCalledWith({
        component: StartStorylineModal,
        props: { sparkImage },
      });
      trigger.mockRestore();
    });
  });
});
