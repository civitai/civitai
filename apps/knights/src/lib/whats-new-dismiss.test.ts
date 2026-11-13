import type { ActionResult } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  DISMISS_FAILED,
  dismissWhatsNew,
  forgetDismissal,
  whatsNewShowing,
  type DismissState,
} from './whats-new-dismiss';

type Answer = (opts: { result: ActionResult; update: () => Promise<void> }) => Promise<void>;

const submitWith = async (state: DismissState) => {
  const submit = dismissWhatsNew(state);
  return (await submit({} as never)) as unknown as Answer;
};

describe('dismissWhatsNew', () => {
  it('hides the dialog as soon as it is submitted, before the server answers', async () => {
    const state: DismissState = { hidden: false, message: null };
    const answer = await submitWith(state);
    expect(state.hidden).toBe(true);

    const update = vi.fn(async () => {});
    await answer({ result: { type: 'success', status: 200 }, update });
    expect(state.hidden).toBe(true);
    expect(update).toHaveBeenCalledOnce();
  });

  it('shows it again when the server refuses or cannot be reached', async () => {
    const refused: DismissState = { hidden: false, message: null };
    const update = vi.fn(async () => {});
    await (
      await submitWith(refused)
    )({
      result: { type: 'failure', status: 500, data: { whatsNewFailed: true } },
      update,
    });
    expect(refused.hidden).toBe(false);
    // The action's own message reaches the dialog through page.form, which update() sets.
    expect(update).toHaveBeenCalledOnce();

    const unreachable: DismissState = { hidden: false, message: null };
    const noUpdate = vi.fn(async () => {});
    await (
      await submitWith(unreachable)
    )({
      result: { type: 'error', error: new TypeError('Failed to fetch') },
      update: noUpdate,
    });
    expect(unreachable).toEqual({ hidden: false, message: DISMISS_FAILED });
    expect(noUpdate).not.toHaveBeenCalled();
  });

  it("treats What's new as closed once it has been submitted", async () => {
    const state: DismissState = { hidden: false, message: null };
    expect(whatsNewShowing(true, state)).toBe(true);
    await submitWith(state);
    expect(whatsNewShowing(true, state)).toBe(false);
  });

  it('blocks the keys again when the dismiss fails', async () => {
    const state: DismissState = { hidden: false, message: null };
    const answer = await submitWith(state);
    await answer({
      result: { type: 'error', error: new TypeError('Failed to fetch') },
      update: vi.fn(),
    });
    expect(whatsNewShowing(true, state)).toBe(true);
  });

  it("shows a later What's new after a successful dismiss", async () => {
    const state: DismissState = { hidden: false, message: null };
    const answer = await submitWith(state);
    await answer({ result: { type: 'success', status: 200 }, update: vi.fn(async () => {}) });
    // The load re-ran and stopped sending it.
    forgetDismissal(state, false);
    expect(whatsNewShowing(false, state)).toBe(false);
    expect(whatsNewShowing(true, state)).toBe(true);
  });
});
