import { describe, expect, it } from 'vitest';
import { getAdditionalResourceFeeAction } from './additional-resource-fee-action';

// The server write is idempotent, so a menu that requested the current state would
// silently do nothing on every click. `next` must always be the opposite state.
describe('getAdditionalResourceFeeAction', () => {
  it('offers to waive a charged version, and requests waived', () => {
    expect(getAdditionalResourceFeeAction(false)).toMatchObject({
      label: 'Waive additional resource fee',
      next: true,
    });
  });

  it('offers to charge a waived version, and requests not waived', () => {
    expect(getAdditionalResourceFeeAction(true)).toMatchObject({
      label: 'Charge additional resource fee',
      next: false,
    });
  });
});
