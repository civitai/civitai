import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';
import { NsfwLevel } from '~/server/common/enums';
import { imageStore } from '~/store/image.store';

/**
 * The scan result reaches the editor as a signal that lands in the image store. The card must show
 * the rating from the store, not only the one it was uploaded with.
 */

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({
      images: [],
      updateImage: vi.fn(),
      setImages: vi.fn(),
      post: { id: 1, user: { id: 9 } },
    }),
  usePostPreviewContext: () => ({ showPreview: false }),
}));
vi.mock('~/hooks/useCurrentUser', async (orig) => ({
  ...(await orig<object>()),
  useCurrentUserRequired: () => ({ id: 9 }),
  useCurrentUser: () => ({ id: 9 }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (orig) => ({
  ...(await orig<object>()),
  EdgeMedia: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<object>()),
  useFeatureFlags: () => new Proxy({}, { get: () => false }),
}));
vi.mock('~/components/VotableTags/VotableTags', () => ({ VotableTags: () => null }));

// eslint-disable-next-line import/first
import { AddedImage } from '~/components/Post/EditV2/PostImageCards/AddedImage';

const uploaded = {
  id: 501,
  type: 'image',
  url: 'u',
  name: 'a.png',
  nsfwLevel: 0,
  ingestion: 'Pending',
  tags: [],
  techniques: [],
  tools: [],
  resourceHelper: [],
  metadata: { width: 100, height: 100 },
} as never;

describe('the post editor image card rating', () => {
  test('shows the rating once the scan signal stores it', async () => {
    renderWithProviders(<AddedImage image={uploaded} />);
    await expect.element(page.getByText('PG', { exact: true })).not.toBeInTheDocument();

    act(() => {
      imageStore.setImage(501, { ingestion: 'Scanned' as never, nsfwLevel: NsfwLevel.PG });
    });

    await expect.element(page.getByText('PG', { exact: true })).toBeVisible();
  });
});
