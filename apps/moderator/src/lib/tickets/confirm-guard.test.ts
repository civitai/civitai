import { describe, expect, it, vi } from 'vitest';
import { cancelUnlessConfirming } from './confirm-guard';

const submit = (isConfirming: boolean) => {
  const cancel = vi.fn();
  cancelUnlessConfirming(() => isConfirming)({ cancel } as never);
  return cancel;
};

describe('cancelUnlessConfirming', () => {
  it('cancels a submit that did not come from the confirm button (Enter in a field)', () => {
    expect(submit(false)).toHaveBeenCalledTimes(1);
  });

  it('lets the confirmed submit through', () => {
    expect(submit(true)).not.toHaveBeenCalled();
  });
});
