import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import { chooseFiles } from '../../../../test/unreadable-files';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as NotificationsMod from '@mantine/notifications';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * post.create can be refused by the server (a second chapter 1, a daily limit, ...). The dropzone
 * has to say so: a refusal that only reaches the console leaves a file chosen and nothing happening.
 * Unlike PostImageDropzone.storyline.browser.test.tsx, the error notifier here is the real one.
 */

const mocks = vi.hoisted(() => ({
  createPost: vi.fn(),
  notify: vi.fn(),
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
  usePostEditParams: () => ({ storyline: 4 }),
}));

vi.mock('@mantine/notifications', async (orig) => ({
  ...(await orig<typeof NotificationsMod>()),
  showNotification: mocks.notify,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, muted: false }) }));

// eslint-disable-next-line import/first
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';

const REFUSAL = 'This storyline already has its first chapter';

beforeEach(() => {
  mocks.createPost.mockReset();
  mocks.notify.mockReset();
});

describe('PostImageDropzone when the server refuses post.create', () => {
  test('shows the server reason in an error notification', async () => {
    mocks.createPost.mockImplementation((_input, options) => options.onError({ message: REFUSAL }));
    renderWithProviders(
      <div data-testid="post-dropzone">
        <PostImageDropzone />
      </div>
    );
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(
        '[data-testid="post-dropzone"] input[type=file]:not([data-testid="unreadable-pick-files-input"])'
      );
      if (!el) throw new Error('dropzone input not found');
      return el;
    });
    await chooseFiles(input, [
      new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }),
    ]);

    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    expect(mocks.notify.mock.calls[0]![0]).toMatchObject({
      color: 'red',
      title: 'Failed to create post',
      message: REFUSAL,
    });
  });
});
