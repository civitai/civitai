import { describe, expect, it } from 'vitest';
import {
  closeDismiss,
  dismissFailedOn,
  dismissShowing,
  settleDismiss,
  syncDismiss,
  type DismissState,
} from '$lib/optimistic-dismiss';
import { noticeKey } from './level-notice';

const fresh = (): DismissState => ({ closed: null, failed: null });
const level6 = noticeKey({ rank: 'Acolyte', level: 6 });
const level10 = noticeKey({ rank: 'Acolyte', level: 10 });

describe('level notice', () => {
  it('a notice nobody dismissed is showing', () => {
    expect(dismissShowing(level6, fresh())).toBe(true);
    expect(dismissShowing(null, fresh())).toBe(false);
  });

  it('the card is gone before the action resolves', () => {
    const state = fresh();
    closeDismiss(state, level6);
    expect(dismissShowing(level6, state)).toBe(false);
  });

  it('it comes back when the action fails', () => {
    const state = fresh();
    closeDismiss(state, level6);
    settleDismiss(state, level6, false);
    expect(dismissShowing(level6, state)).toBe(true);
  });

  it('stays closed when the action succeeds', () => {
    const state = fresh();
    closeDismiss(state, level6);
    settleDismiss(state, level6, true);
    expect(dismissShowing(level6, state)).toBe(false);
  });

  it('a later milestone shows its own card', () => {
    const state = fresh();
    closeDismiss(state, level6);
    syncDismiss(state, level10);
    expect(dismissShowing(level10, state)).toBe(true);
  });

  it('the same standing reached again after the server stopped sending it shows again', () => {
    const state = fresh();
    closeDismiss(state, level6);
    syncDismiss(state, null);
    syncDismiss(state, level6);
    expect(dismissShowing(level6, state)).toBe(true);
  });

  it("a failed dismissal's error shows on its own card, not on a later one", () => {
    const state = fresh();
    closeDismiss(state, level6);
    settleDismiss(state, level6, false);
    expect(dismissFailedOn(state, level6)).toBe(true);
    syncDismiss(state, level10);
    expect(dismissFailedOn(state, level10)).toBe(false);
  });

  it('no dismissal error once the card is dismissed, or when the same standing comes back later', () => {
    const state = fresh();
    closeDismiss(state, level6);
    settleDismiss(state, level6, false);
    closeDismiss(state, level6);
    settleDismiss(state, level6, true);
    expect(dismissFailedOn(state, level6)).toBe(false);

    settleDismiss(state, level6, false);
    syncDismiss(state, null);
    syncDismiss(state, level6);
    expect(dismissFailedOn(state, level6)).toBe(false);
  });
});
