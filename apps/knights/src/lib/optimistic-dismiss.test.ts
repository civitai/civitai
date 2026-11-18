import { describe, expect, it, vi } from 'vitest';
import { DISMISS_FAILED } from './notice-copy';
import {
  dismissFailedOn,
  dismissShowing,
  optimisticDismiss,
  type DismissState,
} from './optimistic-dismiss';

const fresh = (): DismissState => ({ closed: null, failed: null });

type Result =
  | Parameters<Parameters<typeof optimisticDismiss>[0]['apply']>[0]
  | { type: 'success' | 'redirect' };

/** Drives the submit function as `use:enhance` does: submit, then the answer. */
function post(submit: ReturnType<typeof optimisticDismiss>) {
  const callback = (submit as (input: unknown) => (opts: unknown) => Promise<void>)({});
  const update = vi.fn(() => new Promise<void>(() => {}));
  return {
    update,
    answer: (result: Result | { type: 'failure' | 'error' }) => callback({ result, update }),
  };
}

describe('optimisticDismiss', () => {
  const setup = (key: string | null = 'ruling') => {
    const state = fresh();
    const apply = vi.fn(async () => {});
    const submit = optimisticDismiss({
      state,
      key: () => key,
      failure: { noticeFailed: true },
      apply,
    });
    return { state, apply, submit };
  };

  it('hides the notice before the request resolves, and does not wait on the reload', async () => {
    const { state, submit } = setup();
    const { answer, update } = post(submit);
    expect(dismissShowing('ruling', state)).toBe(false);
    // `update` never settles here, as a slow reload of the page would not: the answer must not wait on it.
    await answer({ type: 'success' });
    expect(update).toHaveBeenCalledOnce();
    expect(dismissShowing('ruling', state)).toBe(false);
  });

  it('brings a refused notice back, with the action error', async () => {
    const { state, submit } = setup();
    const { answer, update } = post(submit);
    update.mockResolvedValue(undefined);
    await answer({ type: 'failure' });
    expect(dismissShowing('ruling', state)).toBe(true);
    expect(dismissFailedOn(state, 'ruling')).toBe(true);
    expect(update).toHaveBeenCalledOnce();
  });

  it('brings a lost one back with the dismissal error, not the error page', async () => {
    const { state, apply, submit } = setup();
    await post(submit).answer({ type: 'error' });
    expect(dismissShowing('ruling', state)).toBe(true);
    expect(apply).toHaveBeenCalledWith({
      type: 'failure',
      status: 500,
      data: { message: DISMISS_FAILED, noticeFailed: true },
    });
  });
});
