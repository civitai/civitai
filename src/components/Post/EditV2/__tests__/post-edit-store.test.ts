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

const added = (id: number, index: number) =>
  ({ type: 'added', data: { id, index } } as unknown as ControlledImage);

describe('post editor image list', () => {
  it('holds one tile when the same saved image is pushed twice', () => {
    const store = createContextStore();
    store.getState().setImages((images) => [...images, added(149466458, 1)]);
    store.getState().setImages((images) => [...images, added(149466458, 1)]);
    expect(store.getState().images).toHaveLength(1);
  });
});
