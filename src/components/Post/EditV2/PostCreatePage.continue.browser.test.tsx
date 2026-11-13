import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * /posts/create?continues=<chapter> is the storyline continue flow. Before the upload, the page
 * heading names what is being written instead of the generic "Create Image Post".
 */

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: makeTrpcProxy({}) };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ post: undefined, images: [], setImages: vi.fn() }),
  usePostEditParams: () => ({}),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, muted: false }) }));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

// eslint-disable-next-line import/first
import CreatePostPage from '~/pages/posts/create';

// The scaffold mocks next/router; this is its shared object, not a hook call.
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();

beforeEach(() => {
  router.query = {};
});

describe('the create post page heading', () => {
  test('continuing a chapter says it is the next chapter, not a generic image post', async () => {
    router.query = { continues: '31', n: '2' };
    renderWithProviders(<CreatePostPage />);

    await expect
      .element(page.getByRole('heading', { name: 'Write the next chapter' }))
      .toBeVisible();
    expect(page.getByText('Create Image Post').elements()).toHaveLength(0);
  });

  test('without ?continues= the generic heading stays', async () => {
    renderWithProviders(<CreatePostPage />);

    await expect.element(page.getByRole('heading', { name: 'Create Image Post' })).toBeVisible();
    expect(page.getByText('Write the next chapter').elements()).toHaveLength(0);
  });
});
