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
    timer.hover(true);
    vi.advanceTimersByTime(60_000);
    timer.focus(true);
    timer.hover(false);
    vi.advanceTimersByTime(60_000);
    expect(hide).not.toHaveBeenCalled();

    timer.focus(false);
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
    timer.hover(true);
    timer.hover(false);
    vi.advanceTimersByTime(5000);
    expect(hide).toHaveBeenCalledOnce();
  });
});
