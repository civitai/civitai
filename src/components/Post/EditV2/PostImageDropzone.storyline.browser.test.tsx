import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import { chooseFiles } from '../../../../test/unreadable-files';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as ShowCreatePostErrorMod from '~/components/Post/showCreatePostError';

/**
 * The first upload of /posts/create?storyline=<id> creates the post, and that is where the draft is
 * linked to its storyline: the param has to reach post.create (see PostImageDropzone.tsx).
 */

const mocks = vi.hoisted(() => ({
  createPost: vi.fn(),
  params: {} as Record<string, unknown>,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'post.create': { useMutation: () => ({ mutate: mocks.createPost, isPending: false }) },
    }),
  };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ post: undefined, images: [], setImages: vi.fn() }),
  usePostEditParams: () => mocks.params,
}));

vi.mock('~/components/Post/showCreatePostError', async (orig) => ({
  ...(await orig<typeof ShowCreatePostErrorMod>()),
  useShowCreatePostError: () => vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, muted: false }) }));

// eslint-disable-next-line import/first
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';

const dropzoneInput = () =>
  vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="post-dropzone"] input[type=file]:not([data-testid="unreadable-pick-files-input"])'
    );
    if (!input) throw new Error('dropzone input not found');
    return input;
  });

beforeEach(() => {
  mocks.createPost.mockReset();
  mocks.params = {};
});

async function dropOneFile() {
  renderWithProviders(
    <div data-testid="post-dropzone">
      <PostImageDropzone />
    </div>
  );
  await chooseFiles(dropzoneInput(), [
    new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }),
  ]);
  await vi.waitFor(() => expect(mocks.createPost).toHaveBeenCalledTimes(1));
}

describe('PostImageDropzone creating the post of a storyline', () => {
  test('carries the storyline into post.create as chapter 1', async () => {
    mocks.params = { storyline: 12 };
    await dropOneFile();

    expect(mocks.createPost.mock.calls[0]![0]).toMatchObject({ storylineId: 12 });
  });

  test('an ordinary post is created with no storyline', async () => {
    await dropOneFile();

    expect(mocks.createPost.mock.calls[0]![0].storylineId).toBeUndefined();
  });
});
