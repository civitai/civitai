import { describe, expect, it, vi } from 'vitest';

// The module holds its keys for the browser session, so each case loads a fresh copy.
const load = async () => {
  vi.resetModules();
  return import('../payment-intent-keys');
};

// What the server answers, as the client sees it: a tRPC error carrying the HTTP status in `data`.
const httpError = (httpStatus: number) =>
  Object.assign(new Error('nope'), { data: { httpStatus } });

describe('payment intent keys', () => {
  it('resends the same key for the same action after a failure that may have charged', async () => {
    const { withPaymentIntentKey } = await load();
    const keys: string[] = [];
    const send = async (key: string) => {
      keys.push(key);
      throw httpError(500);
    };

    await expect(withPaymentIntentKey('creator-shop-item:Badge:yellow', send)).rejects.toThrow();
    await expect(withPaymentIntentKey('creator-shop-item:Badge:yellow', send)).rejects.toThrow();
    // A network failure has no status at all, and holds too.
    await expect(
      withPaymentIntentKey('creator-shop-item:Badge:yellow', async (key) => {
        keys.push(key);
        throw new TypeError('Failed to fetch');
      })
    ).rejects.toThrow();

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('starts a new action with a new key after success, or after a decline', async () => {
    const { withPaymentIntentKey } = await load();
    const keys: string[] = [];
    const record = async (key: string) => void keys.push(key);

    await withPaymentIntentKey('intent', record);
    await withPaymentIntentKey('intent', record);
    await expect(
      withPaymentIntentKey('intent', async (key) => {
        keys.push(key);
        throw httpError(400);
      })
    ).rejects.toThrow();
    await withPaymentIntentKey('intent', record);

    expect(new Set(keys).size).toBe(4);
  });

  it('holds the key across a 408 and a 429, which may be the same action still in flight', async () => {
    const { withPaymentIntentKey } = await load();
    const keys: string[] = [];
    for (const status of [408, 429]) {
      await expect(
        withPaymentIntentKey('intent', async (key) => {
          keys.push(key);
          throw httpError(status);
        })
      ).rejects.toThrow();
    }
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps different actions apart', async () => {
    const { paymentIntentKey, tipIntent } = await load();
    const tip = {
      toAccountId: 5,
      entityType: 'Image',
      entityId: 7,
      amount: 100,
      fromAccountType: 'yellow',
    };

    expect(paymentIntentKey(tipIntent(tip))).toBe(paymentIntentKey(tipIntent({ ...tip })));
    expect(paymentIntentKey(tipIntent(tip))).not.toBe(
      paymentIntentKey(tipIntent({ ...tip, amount: 200 }))
    );
    expect(paymentIntentKey(tipIntent(tip))).not.toBe(
      paymentIntentKey(tipIntent({ ...tip, entityId: 8 }))
    );
    expect(paymentIntentKey(tipIntent(tip))).not.toBe(
      paymentIntentKey(tipIntent({ ...tip, fromAccountType: 'green' }))
    );
  });

  it('a stale attempt settling does not release a newer attempt’s key', async () => {
    const { paymentIntentKey, settlePaymentIntentKey } = await load();
    const first = paymentIntentKey('intent');
    settlePaymentIntentKey('intent', first);
    const second = paymentIntentKey('intent');
    settlePaymentIntentKey('intent', first);
    expect(paymentIntentKey('intent')).toBe(second);
  });
});
