import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isThrottlingError, withThrottleRetry, type Sleep } from '../pacing';

const throttle = () =>
  Object.assign(new Error('454 Throttling failure: Maximum sending rate exceeded'), {
    responseCode: 454,
  });

describe('isThrottlingError', () => {
  it('knows an SES throttle by its SMTP code or its message, and nothing else', () => {
    expect(isThrottlingError(throttle())).toBe(true);
    expect(isThrottlingError(new Error('Throttling failure: Maximum sending rate exceeded'))).toBe(
      true
    );
    expect(isThrottlingError(Object.assign(new Error('x'), { responseCode: 454 }))).toBe(true);
    expect(isThrottlingError(new Error('Email(s) (a@b.c) could not be sent'))).toBe(false);
    expect(isThrottlingError(Object.assign(new Error('x'), { responseCode: 550 }))).toBe(false);
  });
});

describe('withThrottleRetry', () => {
  const sleep = vi.fn<Sleep>(async () => undefined);
  beforeEach(() => sleep.mockClear());

  it('retries a throttled call after each delay until it succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(throttle()).mockResolvedValueOnce('ok');
    await expect(withThrottleRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[2_000]]);
  });

  it('gives up with the throttle after the last delay', async () => {
    const fn = vi.fn().mockRejectedValue(throttle());
    await expect(withThrottleRetry(fn, { sleep })).rejects.toThrow('Throttling');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [5_000]]);
  });

  it('does not retry any other failure', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('rejected'));
    await expect(withThrottleRetry(fn, { sleep })).rejects.toThrow('rejected');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
