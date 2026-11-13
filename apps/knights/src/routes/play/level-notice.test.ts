import { describe, expect, it } from 'vitest';
import {
  closeNotice,
  dismissFailedOn,
  noticeKey,
  noticeShowing,
  settleNotice,
  syncNotice,
  type NoticeState,
} from './level-notice';

const fresh = (): NoticeState => ({ closed: null, failed: null });
const level6 = noticeKey({ rank: 'Acolyte', level: 6 });
const level10 = noticeKey({ rank: 'Acolyte', level: 10 });

describe('level notice', () => {
  it('a notice nobody dismissed is showing', () => {
    expect(noticeShowing(level6, fresh())).toBe(true);
    expect(noticeShowing(null, fresh())).toBe(false);
  });

  it('the card is gone before the action resolves', () => {
    const state = fresh();
    closeNotice(state, level6);
    expect(noticeShowing(level6, state)).toBe(false);
  });

  it('it comes back when the action fails', () => {
    const state = fresh();
    closeNotice(state, level6);
    settleNotice(state, level6, false);
    expect(noticeShowing(level6, state)).toBe(true);
  });

  it('stays closed when the action succeeds', () => {
    const state = fresh();
    closeNotice(state, level6);
    settleNotice(state, level6, true);
    expect(noticeShowing(level6, state)).toBe(false);
  });

  it('a later milestone shows its own card', () => {
    const state = fresh();
    closeNotice(state, level6);
    syncNotice(state, level10);
    expect(noticeShowing(level10, state)).toBe(true);
  });

  it('the same standing reached again after the server stopped sending it shows again', () => {
    const state = fresh();
    closeNotice(state, level6);
    syncNotice(state, null);
    syncNotice(state, level6);
    expect(noticeShowing(level6, state)).toBe(true);
  });

  it("a failed dismissal's error shows on its own card, not on a later one", () => {
    const state = fresh();
    closeNotice(state, level6);
    settleNotice(state, level6, false);
    expect(dismissFailedOn(state, level6)).toBe(true);
    syncNotice(state, level10);
    expect(dismissFailedOn(state, level10)).toBe(false);
  });

  it('no dismissal error once the card is dismissed, or when the same standing comes back later', () => {
    const state = fresh();
    closeNotice(state, level6);
    settleNotice(state, level6, false);
    closeNotice(state, level6);
    settleNotice(state, level6, true);
    expect(dismissFailedOn(state, level6)).toBe(false);

    settleNotice(state, level6, false);
    syncNotice(state, null);
    syncNotice(state, level6);
    expect(dismissFailedOn(state, level6)).toBe(false);
  });
});
