import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEVEL_AUTO_HIDE_MS,
  RULING_AUTO_HIDE_MS,
  countdownStyle,
  createAutoHide,
} from './auto-hide';

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

  it('waits while hovered or focused, then runs out the time it had left', () => {
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
    vi.advanceTimersByTime(RULING_AUTO_HIDE_MS - 5000 - 1);
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
      const timer = createAutoHide(RULING_AUTO_HIDE_MS, hide, { held: [reason] });
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

  it("drives the countdown bar: the delay's length, paused exactly while the timer waits", () => {
    expect(countdownStyle(RULING_AUTO_HIDE_MS, false)).toEqual({
      '--auto-hide-ms': '8000ms',
      '--auto-hide-state': 'running',
    });
    expect(countdownStyle(LEVEL_AUTO_HIDE_MS, true)['--auto-hide-ms']).toBe('6000ms');
    expect(countdownStyle(LEVEL_AUTO_HIDE_MS, true)['--auto-hide-state']).toBe('paused');

    const paused: boolean[] = [];
    const hide = vi.fn();
    const timer = createAutoHide(RULING_AUTO_HIDE_MS, hide, { onpause: (on) => paused.push(on) });
    expect(timer.paused).toBe(false);
    vi.advanceTimersByTime(3000);
    timer.hold('hover', true);
    expect(timer.paused).toBe(true);
    timer.hold('focus', true);
    timer.hold('hover', false);
    expect(timer.paused).toBe(true);
    timer.hold('focus', false);
    expect(paused).toEqual([true, false]);
    vi.advanceTimersByTime(RULING_AUTO_HIDE_MS - 3000);
    expect(hide).toHaveBeenCalledOnce();
  });
});
