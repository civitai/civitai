import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL_AUTO_HIDE_MS, RULING_AUTO_HIDE_MS, createAutoHide } from './auto-hide';

describe('createAutoHide', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hides the level-up card after 6 seconds', () => {
    const hide = vi.fn();
    createAutoHide(LEVEL_AUTO_HIDE_MS, hide);
    vi.advanceTimersByTime(5999);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledOnce();
  });

  it('waits while hovered or focused, and gives the full time again once left', () => {
    const hide = vi.fn();
    const timer = createAutoHide(RULING_AUTO_HIDE_MS, hide);
    vi.advanceTimersByTime(5000);
    timer.hold('hover', true);
    vi.advanceTimersByTime(60_000);
    timer.hold('focus', true);
    timer.hold('hover', false);
    vi.advanceTimersByTime(60_000);
    expect(hide).not.toHaveBeenCalled();

    timer.hold('focus', false);
    vi.advanceTimersByTime(RULING_AUTO_HIDE_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledOnce();
  });

  it('never fires once stopped, or twice', () => {
    const hide = vi.fn();
    createAutoHide(1000, hide).stop();
    vi.advanceTimersByTime(5000);
    expect(hide).not.toHaveBeenCalled();

    const timer = createAutoHide(1000, hide);
    vi.advanceTimersByTime(1000);
    timer.hold('hover', true);
    timer.hold('hover', false);
    vi.advanceTimersByTime(5000);
    expect(hide).toHaveBeenCalledOnce();
  });

  it('waits while the tab is hidden, a dialog is up or a failed dismissal shows its error', () => {
    for (const reason of ['hidden', 'dialog', 'message']) {
      const hide = vi.fn();
      const timer = createAutoHide(RULING_AUTO_HIDE_MS, hide, [reason]);
      vi.advanceTimersByTime(60_000);
      expect(hide).not.toHaveBeenCalled();
      timer.hold(reason, false);
      vi.advanceTimersByTime(RULING_AUTO_HIDE_MS);
      expect(hide).toHaveBeenCalledOnce();
    }
  });

  it('a release that was never held does not restart the time', () => {
    const hide = vi.fn();
    const timer = createAutoHide(RULING_AUTO_HIDE_MS, hide);
    vi.advanceTimersByTime(5000);
    timer.hold('focus', false);
    timer.hold('hover', false);
    vi.advanceTimersByTime(RULING_AUTO_HIDE_MS - 5000);
    expect(hide).toHaveBeenCalledOnce();
  });
});
