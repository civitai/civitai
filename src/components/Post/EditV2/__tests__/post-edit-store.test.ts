import { describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({}),
}));
vi.mock('next/router', () => ({ default: {} }));

import { createContextStore } from '~/components/Post/EditV2/PostEditProvider';
import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';
import type { PostDetailEditable } from '~/server/services/post.service';

const added = (id: number, index: number) =>
  ({ type: 'added', data: { id, index } } as unknown as ControlledImage);

describe('post editor image list', () => {
  it('opens with one tile when the loaded post repeats an image id', () => {
    const post = {
      id: 1,
      images: [
        { id: 5, index: 0 },
        { id: 5, index: 1 },
        { id: 6, index: 2 },
      ],
    };
    const store = createContextStore(post as unknown as PostDetailEditable);
    expect(store.getState().images.map((x) => (x.data as { id: number }).id)).toEqual([5, 6]);
  });

  it('holds one tile when the same saved image is pushed twice', () => {
    const store = createContextStore();
    store.getState().setImages((images) => [...images, added(149466458, 1)]);
    store.getState().setImages((images) => [...images, added(149466458, 1)]);
    expect(store.getState().images).toHaveLength(1);
  });
});
