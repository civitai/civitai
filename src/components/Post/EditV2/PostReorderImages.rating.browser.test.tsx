import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';
import { NsfwLevel } from '~/server/common/enums';
import { imageStore } from '~/store/image.store';

/**
 * Rearrange tiles show the rating from the image store (scan result), not only the one the post
 * payload carried.
 */

const added = (id: number, nsfwLevel: number) => ({
  type: 'added' as const,
  data: {
    id,
    type: 'image',
    url: `u${id}`,
    name: `${id}.png`,
    index: id,
    nsfwLevel,
    ingestion: 'Pending',
    metadata: { width: 100, height: 100 },
  },
});

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({
      images: [added(601, 0), added(602, NsfwLevel.R)],
      setImages: vi.fn(),
      post: { id: 1 },
      isReordering: true,
      toggleReordering: vi.fn(),
    }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (orig) => ({
  ...(await orig<object>()),
  EdgeMedia: () => null,
}));

// eslint-disable-next-line import/first
import { PostReorderImages } from '~/components/Post/EditV2/PostReorderImages';

describe('rearrange tile rating badge', () => {
  test('shows the payload rating, then the store rating once a scan lands', async () => {
    renderWithProviders(<PostReorderImages />);
    await expect.element(page.getByText('R', { exact: true })).toBeVisible();
    await expect.element(page.getByText('PG', { exact: true })).not.toBeInTheDocument();

    act(() => {
      imageStore.setImage(601, { ingestion: 'Scanned' as never, nsfwLevel: NsfwLevel.PG });
    });

    await expect.element(page.getByText('PG', { exact: true })).toBeVisible();

    act(() => {
      imageStore.setImage(602, { ingestion: 'Scanned' as never, nsfwLevel: NsfwLevel.X });
    });

    await expect.element(page.getByText('X', { exact: true })).toBeVisible();
    await expect.element(page.getByText('R', { exact: true })).not.toBeInTheDocument();
  });
});
