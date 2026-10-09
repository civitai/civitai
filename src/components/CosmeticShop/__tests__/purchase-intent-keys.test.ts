// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import type * as Trpc from '~/utils/trpc';
import type * as Notifications from '~/utils/notifications';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { PURCHASE_ALREADY_COMPLETED_MESSAGE } from '~/shared/constants/cosmetic-shop.constants';

// What the server answers, as the client sees it: a tRPC error carrying the
// HTTP status in `data`.
const send = vi.fn();
const httpError = (httpStatus: number, message = 'nope') =>
  Object.assign(new Error(message), { data: { httpStatus } });

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'cosmeticShop.purchaseShopItem': {
      // Runs the hook's own callbacks around the call, as react-query does.
      useMutation: (options: {
        onSuccess?: (data: unknown, input: unknown) => Promise<void>;
        onError?: (error: unknown) => void;
      }) => ({
        isPending: false,
        mutateAsync: async (input: unknown) => {
          try {
            const result = await send(input);
            await options.onSuccess?.(result, input);
            return result;
          } catch (error) {
            options.onError?.(error);
            throw error;
          }
        },
      }),
    },
  }),
}));
const showErrorNotification = vi.fn();
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: (...a: unknown[]) => showErrorNotification(...a),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

const { useMutateCosmeticShop } = await import('~/components/CosmeticShop/cosmetic-shop.util');
const { usePurchaseIntentKeyStore } = await import(
  '~/components/CosmeticShop/purchase-intent-keys'
);
const { mintPurchaseKey } = await import('~/utils/purchase-key');
const { useStickerPlacementDraftStore } = await import('~/store/sticker-placement-draft.store');

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Purchase = ReturnType<typeof useMutateCosmeticShop>['purchaseShopItem'];
let root: Root | undefined;
let container: HTMLDivElement | undefined;

// Mounts a component using the hook and hands back its purchase function, the
// way a purchase modal holds it.
function mountPurchaser(): Purchase {
  let purchase: Purchase | undefined;
  function Purchaser() {
    purchase = useMutateCosmeticShop().purchaseShopItem;
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(Purchaser)));
  return purchase!;
}
function unmount() {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
}

const SHOP_ITEM_ID = 42;
const buy = (purchase: Purchase, idempotencyKey?: string) =>
  purchase({ shopItemId: SHOP_ITEM_ID, idempotencyKey });
const keySent = (call: number) =>
  (send.mock.calls[call][0] as { idempotencyKey?: string }).idempotencyKey;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  send.mockReset();
  showErrorNotification.mockReset();
  usePurchaseIntentKeyStore.setState({ keys: {} });
});
afterEach(() => unmount());

describe('purchase intent keys', () => {
  it('sends a key with every purchase', async () => {
    send.mockResolvedValue({ claimKey: 'x' });
    await buy(mountPurchaser());
    expect(keySent(0)).toMatch(UUID_V4);
  });

  // Closing the modal while a purchase may have charged, then reopening it, is
  // the same intent: a new key there would charge again.
  it('keeps the key across a remount after a failure that may have charged', async () => {
    send.mockRejectedValueOnce(httpError(503));
    await expect(buy(mountPurchaser())).rejects.toThrow();
    unmount();

    send.mockResolvedValueOnce({ claimKey: 'x' });
    await buy(mountPurchaser());
    expect(keySent(1)).toBe(keySent(0));
  });

  for (const [what, failure] of [
    ['a 5xx', () => httpError(500)],
    ['a 408', () => httpError(408)],
    ['a network error', () => new TypeError('fetch failed')],
  ] as const) {
    it(`holds the key after ${what}`, async () => {
      const purchase = mountPurchaser();
      send.mockRejectedValueOnce(failure());
      await expect(buy(purchase)).rejects.toThrow();
      send.mockResolvedValueOnce({ claimKey: 'x' });
      await buy(purchase);
      expect(keySent(1)).toBe(keySent(0));
    });
  }

  it('starts a new intent after a success', async () => {
    const purchase = mountPurchaser();
    send.mockResolvedValue({ claimKey: 'x' });
    await buy(purchase);
    await buy(purchase);
    expect(keySent(1)).not.toBe(keySent(0));
  });

  it('starts a new intent after the server declined', async () => {
    const purchase = mountPurchaser();
    send.mockRejectedValueOnce(httpError(400));
    await expect(buy(purchase)).rejects.toThrow();
    send.mockResolvedValueOnce({ claimKey: 'x' });
    await buy(purchase);
    expect(keySent(1)).not.toBe(keySent(0));
  });

  it('keys each item separately', async () => {
    const purchase = mountPurchaser();
    send.mockRejectedValue(httpError(503));
    await expect(buy(purchase)).rejects.toThrow();
    await expect(purchase({ shopItemId: SHOP_ITEM_ID + 1 })).rejects.toThrow();
    expect(keySent(1)).not.toBe(keySent(0));
  });

  it("uses the caller's own key untouched", async () => {
    send.mockResolvedValue({ claimKey: 'x' });
    const own = '11111111-1111-4111-8111-111111111111';
    await buy(mountPurchaser(), own);
    expect(keySent(0)).toBe(own);
    expect(usePurchaseIntentKeyStore.getState().keys).toEqual({});
  });
});

// The purchase was granted under this key and its answer never arrived. It is
// the buyer's: report it as done, so nothing offers to sell it again.
describe('a purchase already completed under its key', () => {
  const alreadyCompleted = () => httpError(400, PURCHASE_ALREADY_COMPLETED_MESSAGE);

  it('resolves as a completed purchase, with no error shown', async () => {
    send.mockRejectedValueOnce(alreadyCompleted());
    await expect(buy(mountPurchaser())).resolves.toEqual({ alreadyCompleted: true });
    expect(showErrorNotification).not.toHaveBeenCalled();
  });

  it("resolves for a caller's own key too (the sticker draft)", async () => {
    send.mockRejectedValueOnce(alreadyCompleted());
    await expect(buy(mountPurchaser(), '11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      alreadyCompleted: true,
    });
  });

  it('ends the intent', async () => {
    const purchase = mountPurchaser();
    send.mockRejectedValueOnce(alreadyCompleted());
    await buy(purchase);
    send.mockResolvedValueOnce({ claimKey: 'x' });
    await buy(purchase);
    expect(keySent(1)).not.toBe(keySent(0));
  });

  it('any other refusal still rejects and is shown (control)', async () => {
    send.mockRejectedValueOnce(httpError(400, 'This cosmetic is not available'));
    await expect(buy(mountPurchaser())).rejects.toThrow('not available');
    expect(showErrorNotification).toHaveBeenCalledTimes(1);
  });
});

describe('mintPurchaseKey', () => {
  const realCrypto = globalThis.crypto;
  const getRandomValues = <T extends ArrayBufferView | null>(array: T) =>
    realCrypto.getRandomValues(array as Uint8Array) as unknown as T;

  it('falls back to getRandomValues where randomUUID is missing (plain http)', () => {
    const a = mintPurchaseKey({ getRandomValues });
    const b = mintPurchaseKey({ getRandomValues });
    expect(a).toMatch(UUID_V4);
    expect(b).not.toBe(a);
  });

  it('prefers randomUUID', () => {
    expect(mintPurchaseKey({ getRandomValues, randomUUID: () => 'from-random-uuid' })).toBe(
      'from-random-uuid'
    );
  });

  // The sticker draft's keys used to fall back to a counter, which restarts at
  // 1 on every reload: the second session's first key was the first session's.
  it('the sticker draft store mints random keys without randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues });
    try {
      const store = useStickerPlacementDraftStore.getState();
      const key = store.packPurchaseKey(7);
      expect(key).toMatch(UUID_V4);
      expect(key).not.toBe('00000000-0000-4000-8000-000000000001');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
