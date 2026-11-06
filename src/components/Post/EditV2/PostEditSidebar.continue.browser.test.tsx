import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as NotificationsMod from '@mantine/notifications';
import type { PostDetailEditable } from '~/server/services/post.service';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

/**
 * Publishing a draft that continues a chapter: the button shows the price a contributor will pay
 * and sends that same price, and what the server did with the draft is said once it is published.
 */

const mocks = vi.hoisted(() => ({
  terms: undefined as unknown,
  termsLoading: false,
  invalidatePrice: vi.fn(),
  pending: null as unknown,
  mutate: vi.fn(),
  notify: vi.fn(),
  images: [] as unknown[],
  invalidateForPosts: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'storyline.getPendingForPost': {
          useQuery: () => ({ data: mocks.pending, isLoading: false }),
        },
        'placement.getStorylineContinuePrice': {
          useQuery: () => ({
            data: mocks.terms,
            isLoading: mocks.termsLoading,
            isFetching: false,
            error: null,
          }),
        },
        'post.update': { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      },
      {
        useUtils: () => ({
          storyline: {
            getForPosts: { invalidate: mocks.invalidateForPosts },
            getPendingForPost: { invalidate: vi.fn() },
          },
          image: { getImagesAsPostsInfinite: { invalidate: vi.fn() } },
          placement: { getStorylineContinuePrice: { invalidate: mocks.invalidatePrice } },
        }),
      }
    ),
  };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({
      updatePost: vi.fn(),
      isReordering: false,
      images: mocks.images,
      collectionId: undefined,
      collectionTagId: undefined,
      flushPendingSaves: vi.fn(),
    }),
  usePostEditParams: () => ({}),
}));

vi.mock('@mantine/notifications', async (orig) => ({
  ...(await orig<typeof NotificationsMod>()),
  showNotification: mocks.notify,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ storylines: true, canWrite: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/hooks/useCatchNavigation', () => ({ useCatchNavigation: () => undefined }));
vi.mock('~/components/Tours/ToursProvider', () => ({
  useTourContext: () => ({ runTour: vi.fn(), running: false }),
}));
vi.mock('~/components/Post/post.utils', () => ({
  usePostContestCollectionDetails: () => ({ collection: undefined }),
}));
vi.mock('~/components/Sticker/PlacementSpaceToggle', () => ({ PlacementSpaceToggle: () => null }));
vi.mock('~/components/Post/EditV2/PostEditApplyPreset', () => ({
  PostEditApplyPreset: () => null,
}));
vi.mock('~/components/Post/EditV2/PostEditModelLink', () => ({ PostEditModelLink: () => null }));
vi.mock('~/components/Post/DeletePostButton', () => ({ DeletePostButton: () => null }));
vi.mock('~/components/ShareButton/ShareButton', () => ({
  ShareButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// eslint-disable-next-line import/first
import { PostEditSidebar } from '~/components/Post/EditV2/PostEditSidebar';
import { STORYLINE_QUEUE_SENT_URL } from '~/components/Placement/queue-routes';

const OWNER = 9;
const post = {
  id: 41,
  title: 'Cat patch',
  publishedAt: null,
  user: { id: 1 },
  modelVersionId: null,
  parentModelId: null,
} as unknown as PostDetailEditable;

/** Chapter 4 (depth 3) ends here, so the draft is chapter 5. */
const continuation = (storylineUserId = OWNER) => ({
  postId: 41,
  storyline: { id: 2, title: 'The Patch', userId: storylineUserId },
  parentChapter: { id: 5, depth: 3, postId: 15 },
});
const open = (price: number) => ({ open: true, price, closedReason: null });
const lastInput = () => mocks.mutate.mock.calls.at(-1)![0];

beforeEach(() => {
  mocks.pending = continuation();
  mocks.terms = open(50);
  mocks.termsLoading = false;
  mocks.invalidatePrice.mockReset().mockResolvedValue(undefined);
  mocks.mutate.mockReset();
  mocks.notify.mockReset();
  mocks.invalidateForPosts.mockReset();
  mocks.images = [
    {
      type: 'added',
      data: {
        id: 1,
        nsfwLevel: 1,
        resourceHelper: [],
        tools: [],
        tags: [],
        meta: {},
        needsReview: null,
      },
    },
  ];
  vi.mocked(useRouter().push).mockClear();
});

describe('a contributor publishing a continuation', () => {
  test('the price on the button is the price sent', async () => {
    renderWithProviders(<PostEditSidebar post={post} />);

    await page.getByRole('button', { name: 'Publish and submit · 50 Buzz' }).click();
    expect(lastInput()).toMatchObject({ id: 41, expectedPrice: 50 });
  });

  test('a free storyline says Free and sends 0', async () => {
    mocks.terms = open(0);
    renderWithProviders(<PostEditSidebar post={post} />);

    await page.getByRole('button', { name: 'Publish and submit · Free' }).click();
    expect(lastInput().expectedPrice).toBe(0);
  });

  test('tells them what happens to the Buzz', async () => {
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect
      .element(page.getByTestId('storyline-publish-caption'))
      .toHaveTextContent(/Goes to the creator for review.*50 Buzz is refunded/);
  });

  test('cannot publish while the price is being read', async () => {
    mocks.terms = undefined;
    mocks.termsLoading = true;
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('cannot publish when the price cannot be read, and says so', async () => {
    mocks.terms = undefined;
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await expect
      .element(page.getByTestId('storyline-publish-caption'))
      .toHaveTextContent("Couldn't read what this costs");
  });

  test('publishes as an ordinary post, with no price, once the storyline is closed', async () => {
    mocks.terms = { open: false, price: 0, closedReason: 'closed' };
    renderWithProviders(<PostEditSidebar post={post} />);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    expect(lastInput().expectedPrice).toBeUndefined();
  });

  test('a changed price re-reads it, shows the new one, and the retry sends that', async () => {
    renderWithProviders(<PostEditSidebar post={post} />);
    await page.getByRole('button', { name: 'Publish and submit · 50 Buzz' }).click();
    expect(lastInput().expectedPrice).toBe(50);

    // The server refused; reading the price again finds the new one.
    mocks.invalidatePrice.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      mocks.terms = open(60);
    });
    const [, options] = mocks.mutate.mock.calls[0]!;
    await options.onError(new Error(`${STORYLINE_REFUSALS.priceChanged}: now 60 Buzz`));

    expect(mocks.invalidatePrice).toHaveBeenCalledWith({ parentPostId: 15 });
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'It is now 60 Buzz. Publish again to accept it.' })
    );
    await page.getByRole('button', { name: 'Publish and submit · 60 Buzz' }).click();
    expect(lastInput().expectedPrice).toBe(60);
  });

  test('any other refusal is the ordinary publish error', async () => {
    renderWithProviders(<PostEditSidebar post={post} />);
    await page.getByRole('button', { name: 'Publish and submit · 50 Buzz' }).click();
    const [, options] = mocks.mutate.mock.calls[0]!;
    await options.onError(new Error('nope'));

    expect(mocks.invalidatePrice).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'There was an error while trying to publish your post' })
    );
  });
});

describe('no price is sent for anything but a contributor’s draft', () => {
  test('the owner continuing their own story publishes the chapter by number', async () => {
    mocks.pending = continuation(1);
    renderWithProviders(<PostEditSidebar post={post} />);

    await page.getByRole('button', { name: 'Publish chapter 5' }).click();
    expect(lastInput().expectedPrice).toBeUndefined();
  });

  test('an ordinary post', async () => {
    mocks.pending = null;
    renderWithProviders(<PostEditSidebar post={post} />);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    expect(lastInput().expectedPrice).toBeUndefined();
  });

  test('a chapter 1 draft', async () => {
    mocks.pending = {
      postId: 41,
      storyline: { id: 2, title: 'The Patch', userId: 1 },
      parentChapter: null,
    };
    renderWithProviders(<PostEditSidebar post={post} />);

    await page.getByRole('button', { name: 'Publish chapter 1' }).click();
    expect(lastInput().expectedPrice).toBeUndefined();
  });
});

describe('after publishing a continuation', () => {
  async function publishWith(storyline: unknown, buttonName = 'Publish and submit · 50 Buzz') {
    renderWithProviders(<PostEditSidebar post={post} />);
    await page.getByRole('button', { name: buttonName }).click();
    const [, options] = mocks.mutate.mock.calls[0]!;
    await options.onSuccess({ storyline }, { id: 41, publishedAt: new Date() });
  }
  const said = () => mocks.notify.mock.calls.at(-1)![0];

  // A tester read the old ten-second toast as a failure: it stays, says it waits, and says where.
  test('submitted: says chapter 5 waits for the owner, and links to the sent list', async () => {
    await publishWith({ storylineId: 2, status: 'submitted', placementId: 8 });
    expect(said()).toMatchObject({
      title: 'Submitted, waiting for approval',
      color: 'teal',
      autoClose: false,
    });
    renderWithProviders(<div data-testid="said">{said().message}</div>);
    await expect
      .element(page.getByTestId('said'))
      .toHaveTextContent("Chapter 5 is waiting for the storyline owner's approval.");
    await expect
      .element(page.getByRole('link', { name: 'See your sent continuations' }))
      .toHaveAttribute('href', STORYLINE_QUEUE_SENT_URL);
  });

  test('chapter written: the owner’s chapter is live', async () => {
    mocks.pending = continuation(1);
    await publishWith(
      { storylineId: 2, status: 'chapterWritten', chapterId: 12 },
      'Publish chapter 5'
    );
    expect(said()).toMatchObject({ message: 'Chapter 5 is live.', color: 'teal' });
  });

  test('waiting on the account: added when the account is able to', async () => {
    mocks.pending = continuation(1);
    await publishWith(
      { storylineId: 2, status: 'waiting', reason: 'restricted' },
      'Publish chapter 5'
    );
    expect(said()).toMatchObject({
      message: 'Chapter 5 will be added when your account is able to.',
      color: 'yellow',
    });
  });

  test('dropped: says why, and the post is still published', async () => {
    await publishWith({
      storylineId: 2,
      status: 'dropped',
      reason: 'storyline: this creator is not accepting continuations here',
    });
    expect(said()).toMatchObject({
      message: 'storyline: this creator is not accepting continuations here',
      color: 'red',
    });
    expect(useRouter().push).toHaveBeenCalled();
  });
});
