import { describe, expect, it, vi } from 'vitest';
import {
  createRefreshStepAlert,
  REFRESH_ALERT_WINDOW_MS,
} from '~/server/services/profile-picture-refresh-alert';

const setup = (send = vi.fn((_step: string, _failures: number) => undefined as unknown)) => {
  let clock = 1_000_000;
  const alert = createRefreshStepAlert({ send, now: () => clock });
  return { alert, send, advance: (ms: number) => (clock += ms) };
};

describe('the refresh-step alert', () => {
  it('🔴 alerts the first failure of a step, then not again inside the window', () => {
    const { alert, send, advance } = setup();
    alert('picture-cache');
    alert('picture-cache');
    advance(REFRESH_ALERT_WINDOW_MS - 1);
    alert('picture-cache');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('picture-cache', 1);
  });

  it('alerts again after the window, counting the failures it held back', () => {
    const { alert, send, advance } = setup();
    alert('session');
    alert('session');
    alert('session');
    advance(REFRESH_ALERT_WINDOW_MS);
    alert('session');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('session', 3);
  });

  it('limits each step on its own (control)', () => {
    const { alert, send } = setup();
    alert('picture-cache');
    alert('event-engine-cache');
    expect(send.mock.calls.map(([step]) => step)).toEqual(['picture-cache', 'event-engine-cache']);
  });

  it('🔴 never throws or rejects into the step when the alert itself fails', async () => {
    const onError = vi.fn();
    const rejected = new Error('webhook down');
    const thrown = new Error('no env');
    const rejecting = createRefreshStepAlert({ send: () => Promise.reject(rejected), onError });
    const throwing = createRefreshStepAlert({
      send: () => {
        throw thrown;
      },
      onError,
    });
    expect(rejecting('basic-cache')).toBeUndefined();
    expect(() => throwing('basic-cache')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError.mock.calls).toEqual([[thrown], [rejected]]);
  });

  it('does not wait for the alert to be delivered', () => {
    const { alert } = setup(vi.fn(() => new Promise(() => undefined)));
    expect(alert('search-index')).toBeUndefined();
  });
});
