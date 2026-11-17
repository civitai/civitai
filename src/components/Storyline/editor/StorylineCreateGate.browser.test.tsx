import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * /posts/create?storyline=<id> writes chapter 1. When a stale link (Back after publishing, an old
 * tab) arrives after chapter 1 exists, the server refuses a second one, so the upload is not
 * offered and the storyline is linked instead (see StorylineCreateBanner.tsx).
 */

const mocks = vi.hoisted(() => ({
  storyline: { data: undefined as unknown, isLoading: false },
  sparkImage: undefined as unknown,
  features: {} as Record<string, boolean>,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getById': { useQuery: () => mocks.storyline },
      'image.get': { useQuery: () => ({ data: mocks.sparkImage }) },
    }),
  };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ post: undefined, images: [], setImages: vi.fn() }),
  usePostEditParams: () => ({ storyline: 4 }),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.features,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, muted: false }) }));

// eslint-disable-next-line import/first
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
// eslint-disable-next-line import/first
import { StorylineCreateGate } from '~/components/Storyline/editor/StorylineCreateBanner';

const emptyStoryline = { id: 4, title: 'The Patch', rootChapterId: null, chapterCount: 0 };
const writtenStoryline = { ...emptyStoryline, rootChapterId: 31, chapterCount: 1 };

const dropzoneInputs = () =>
  document.querySelectorAll('[data-testid="post-dropzone"] input[type=file]');

function renderCreateFlow() {
  renderWithProviders(
    <StorylineCreateGate storylineId={4}>
      <div data-testid="post-dropzone">
        <PostImageDropzone />
      </div>
    </StorylineCreateGate>
  );
}

beforeEach(() => {
  mocks.storyline = { data: undefined, isLoading: false };
  mocks.sparkImage = undefined;
  mocks.features = {};
});

describe('the chapter 1 page of a storyline', () => {
  test('an empty storyline offers the upload, under the banner that names the storyline', async () => {
    mocks.storyline = { data: emptyStoryline, isLoading: false };
    renderCreateFlow();

    await expect.element(page.getByRole('link', { name: 'The Patch' })).toBeVisible();
    await vi.waitFor(() => expect(dropzoneInputs().length).toBeGreaterThan(0));
    expect(page.getByText('already written').elements()).toHaveLength(0);
  });

  test('a storyline whose chapter 1 exists says so, links to it, and offers no upload', async () => {
    mocks.storyline = { data: writtenStoryline, isLoading: false };
    renderCreateFlow();

    await expect.element(page.getByText(/already written/)).toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'Open storyline' }))
      .toHaveAttribute('href', '/storylines/4');
    expect(dropzoneInputs()).toHaveLength(0);
  });

  test('is held back while the storyline loads, so no upload starts against an unknown chapter 1', async () => {
    mocks.storyline = { data: undefined, isLoading: true };
    renderCreateFlow();

    await expect.element(page.getByLabelText('Loading storyline')).toBeInTheDocument();
    expect(dropzoneInputs()).toHaveLength(0);
  });

  test('a storyline the viewer cannot read still gets the upload: the server decides', async () => {
    mocks.storyline = { data: undefined, isLoading: false };
    renderCreateFlow();

    await vi.waitFor(() => expect(dropzoneInputs().length).toBeGreaterThan(0));
  });
});

describe('the chapter 1 page of a storyline started from an image', () => {
  const sparkImage = { id: 77, url: 'spark-url', type: 'image', nsfwLevel: 1, hasMeta: true };
  const sparkStoryline = {
    ...emptyStoryline,
    spark: { image: sparkImage, user: { id: 6, username: 'painter' } },
  };
  const sparkPanel = () => page.getByRole('region', { name: 'Your story starts from this image' });

  test('shows the image it started from, and offers a remix of it', async () => {
    mocks.storyline = { data: sparkStoryline, isLoading: false };
    mocks.sparkImage = sparkImage;
    mocks.features = { imageGeneration: true };
    renderCreateFlow();

    await expect.element(sparkPanel().getByText("@painter's")).toBeVisible();
    await expect.element(sparkPanel().getByRole('link')).toHaveAttribute('href', '/images/77');
    await expect
      .element(sparkPanel().getByRole('button', { name: 'Remix this image' }))
      .toBeVisible();
    await vi.waitFor(() => expect(dropzoneInputs().length).toBeGreaterThan(0));
  });

  test('credits an image that cannot be remixed, with no remix offer', async () => {
    mocks.storyline = { data: sparkStoryline, isLoading: false };
    mocks.sparkImage = { ...sparkImage, type: 'audio', hasMeta: false };
    mocks.features = { imageGeneration: true };
    renderCreateFlow();

    await expect.element(sparkPanel().getByRole('link')).toHaveAttribute('href', '/images/77');
    expect(page.getByRole('button', { name: 'Remix this image' }).elements()).toHaveLength(0);
  });

  test('shows no spark panel for a storyline started the usual way', async () => {
    mocks.storyline = { data: emptyStoryline, isLoading: false };
    mocks.features = { imageGeneration: true };
    renderCreateFlow();

    await expect.element(page.getByRole('link', { name: 'The Patch' })).toBeVisible();
    expect(sparkPanel().elements()).toHaveLength(0);
  });
});
