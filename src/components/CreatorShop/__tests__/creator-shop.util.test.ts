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

describe('useMutateCreatorShop takedown notice', () => {
  const result = (over: Record<string, unknown> = {}) => ({
    refunded: 1,
    purchases: 1,
    clawedBack: 0,
    clawedBackPct: 0,
    revokedFrom: 1,
    boxesPulled: 0,
    boxOpeningsRefunded: 0,
    failures: [] as { stage: string }[],
    artworkLeftServing: 0,
    ...over,
  });
  const takedownNotice = async (over: Record<string, unknown>) => {
    await (
      mocks.mutationOptions.takedownItem as unknown as { onSuccess: (r: unknown) => Promise<void> }
    ).onSuccess(result(over));
    return (mocks.showSuccessNotification.mock.calls[0][0] as { message: string }).message;
  };

  it('tells a failed artwork step apart from refund failures', async () => {
    useMutateCreatorShop();
    const message = await takedownNotice({ failures: [{ stage: 'cdn' }, { stage: 'refund' }] });
    expect(message).toContain('1 refund or box step failed');
    expect(message).toContain('Recording its artwork for removal failed');
  });

  it('says when artwork was left for a manual check', async () => {
    useMutateCreatorShop();
    expect(await takedownNotice({ artworkLeftServing: 2 })).toContain('needs a manual check');
    vi.clearAllMocks();
    expect(await takedownNotice({})).not.toMatch(/artwork|manual check/);
  });
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
