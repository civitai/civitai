import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Notifications from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    mutationOptions: {} as Record<string, { onError: (_error: { message: string }) => unknown }>,
    invalidated: [] as string[],
    showErrorNotification: vi.fn(),
    showSuccessNotification: vi.fn(),
  },
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: mocks.showErrorNotification,
  showSuccessNotification: mocks.showSuccessNotification,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const procedures = new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => ({
      useMutation: (options: { onError: (error: { message: string }) => unknown }) => {
        mocks.mutationOptions[name] = options;
        return { mutateAsync: vi.fn(), isLoading: false };
      },
      useQuery: () => ({ data: undefined }),
      useInfiniteQuery: () => ({ data: undefined }),
    }),
  });
  const utils = new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => ({
      invalidate: () => {
        mocks.invalidated.push(name);
        return Promise.resolve();
      },
    }),
  });
  return {
    ...actual,
    trpc: { creatorShop: procedures, useUtils: () => ({ creatorShop: utils }) },
  };
});

const { useMutateCreatorShop } = await import('../creator-shop.util');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invalidated.length = 0;
  for (const key of Object.keys(mocks.mutationOptions)) delete mocks.mutationOptions[key];
});

// The server refuses a submission whose quoted fee no longer matches and tells the
// creator to reopen the form. Reopening only produces a new quote if the rejection
// invalidated the cached one.
describe('useMutateCreatorShop submit rejection', () => {
  it.each(['submitItem', 'submitPack'])('refetches the fee quote after %s fails', async (name) => {
    useMutateCreatorShop();

    await mocks.mutationOptions[name].onError({
      message: 'The submission fee changed to 5000 Buzz while this form was open.',
    });

    expect(mocks.invalidated).toContain('getFees');
    expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1);
  });

  it('leaves the quote alone when a non-submit mutation fails', async () => {
    useMutateCreatorShop();

    await mocks.mutationOptions.updateItem.onError({ message: 'Failed' });

    expect(mocks.invalidated).not.toContain('getFees');
  });
});
