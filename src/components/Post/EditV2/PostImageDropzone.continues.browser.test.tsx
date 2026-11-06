import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import { chooseFiles } from '../../../../test/unreadable-files';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as ShowCreatePostErrorMod from '~/components/Post/showCreatePostError';
import type * as MediaPreprocessors from '~/utils/media-preprocessors';

/**
 * `/posts/create?continues=<chapter>` is the storyline continue flow: the first upload creates the
 * post already linked to the chapter it continues, so publishing it can be submitted as that
 * chapter's continuation.
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
  // No post yet: the first upload creates it.
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ post: undefined, images: [], setImages: vi.fn() }),
  usePostEditParams: () => mocks.params,
}));

vi.mock('~/components/Post/showCreatePostError', async (orig) => ({
  ...(await orig<typeof ShowCreatePostErrorMod>()),
  useShowCreatePostError: () => vi.fn(),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, muted: false }) }));
vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({
    files: [],
    uploadToS3: vi.fn(() => new Promise(() => undefined)),
    resetFiles: vi.fn(),
    removeFile: vi.fn(),
  }),
}));
vi.mock('~/utils/media-preprocessors', async (orig) => ({
  ...(await orig<typeof MediaPreprocessors>()),
  preprocessFile: vi.fn(async (file: File) => ({
    type: 'image' as const,
    name: file.name,
    mimeType: file.type,
    objectUrl: URL.createObjectURL(file),
    metadata: { size: file.size, width: 10, height: 10, hash: '' },
    meta: undefined,
  })),
}));

// eslint-disable-next-line import/first
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';

const drop = async () => {
  renderWithProviders(
    <div data-testid="post-dropzone">
      <PostImageDropzone />
    </div>
  );
  const input = await vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="post-dropzone"] input[type=file]'
    );
    if (!el) throw new Error('dropzone input not found');
    return el;
  });
  await chooseFiles(input, [
    new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }),
  ]);
  await vi.waitFor(() => expect(mocks.createPost).toHaveBeenCalledTimes(1));
  return mocks.createPost.mock.calls[0][0];
};

describe('PostImageDropzone — continuing a storyline chapter', () => {
  beforeEach(() => {
    mocks.createPost.mockReset();
    mocks.params = {};
  });

  test('the first upload creates the post linked to the chapter it continues', async () => {
    mocks.params = { continues: 7, n: 5 };
    expect(await drop()).toMatchObject({ parentChapterId: 7 });
  });

  test('an ordinary post carries no chapter', async () => {
    expect((await drop()).parentChapterId).toBeUndefined();
  });
});
