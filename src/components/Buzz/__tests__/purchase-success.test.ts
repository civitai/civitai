import { describe, expect, it } from 'vitest';
import { onPurchaseSuccessAction } from '~/components/Buzz/purchase-success';

describe('onPurchaseSuccessAction', () => {
  const perform = () => undefined;

  it('runs nothing after a purchase when the action must not ride on it', () => {
    expect(onPurchaseSuccessAction(false, perform)).toBeUndefined();
  });

  it('runs the pending action after a purchase when asked to', () => {
    expect(onPurchaseSuccessAction(true, perform)).toBe(perform);
  });

  it('runs nothing when the flag is absent: BuzzTransactionButton supplies true as its default', () => {
    expect(onPurchaseSuccessAction(undefined, perform)).toBeUndefined();
  });
});
