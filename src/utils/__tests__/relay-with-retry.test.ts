import { describe, it, expect, vi } from 'vitest';
import { relayWithRetry, MAX_RETRY_AFTER_SECONDS } from '~/utils/upload-settlement';

// AUDIT round-2 F1. The relay sheds with 429 once its per-pod memory cap is full, and
// an unretried shed is TERMINAL: the settlement rule reports the ORIGINAL upload error
// rather than the relay's, so the file fails permanently while the server was saying
// "try again shortly".
//
// ⚠ An earlier version of this comment justified the retry by claiming a dropzone batch
// of 10 against a cap of 8 routinely sheds two. A round-3 audit refuted that: the cap is
// per POD, the serving pool's replica floor is in the dozens, and there is no session
// affinity, so one browser's concurrent POSTs spread across pods rather than colliding.
// A shed is an ANOMALY. The retry is still worth having — it is cheap and a lost upload
// is not — but its justification is "cheap insurance", not "this happens constantly".
//
// `sleep` is injected so these run instantly and assert the DELAY VALUE rather than
// waiting for it — the advertised `Retry-After` being honoured is the property, and a
// test that merely waited could not tell 2s from the default.

const headers = (retryAfter?: string) => ({
  get: (n: string) => (n === 'Retry-After' && retryAfter !== undefined ? retryAfter : null),
});
const liveSignal = () => new AbortController().signal;

describe('relayWithRetry', () => {
  it('retries once on 429 and returns the second response', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: headers('2') })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: headers() });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const res = await relayWithRetry(post, {
      signal: liveSignal(),
      sleep,
      defaultRetryAfterSeconds: 9,
    });

    expect(res.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);
    // Honours the ADVERTISED delay (2s), not the injected default (9s). Those are
    // deliberately different so the assertion cannot pass on the wrong one.
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('falls back to the default delay when Retry-After is absent or unusable', async () => {
    for (const bad of [undefined, 'soon', '0', '-3']) {
      const post = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429, headers: headers(bad) })
        .mockResolvedValueOnce({ ok: true, status: 200, headers: headers() });
      const sleep = vi.fn().mockResolvedValue(undefined);

      await relayWithRetry(post, { signal: liveSignal(), sleep, defaultRetryAfterSeconds: 7 });

      expect(sleep, `Retry-After: ${String(bad)}`).toHaveBeenCalledWith(7000);
    }
  });

  it('does NOT retry a non-429 failure — that is a real error, not backpressure', async () => {
    const post = vi.fn().mockResolvedValue({ ok: false, status: 500, headers: headers() });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const res = await relayWithRetry(post, {
      signal: liveSignal(),
      sleep,
      defaultRetryAfterSeconds: 2,
    });

    expect(res.status).toBe(500);
    expect(post).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry at all when the first attempt succeeds', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: headers() });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await relayWithRetry(post, { signal: liveSignal(), sleep, defaultRetryAfterSeconds: 2 });

    expect(post).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('aborts during the backoff instead of spending a second upload', async () => {
    const controller = new AbortController();
    const post = vi.fn().mockResolvedValue({ ok: false, status: 429, headers: headers('1') });
    // Cancel while we are waiting out the backoff — the realistic timing.
    const sleep = vi.fn().mockImplementation(async () => controller.abort());

    await expect(
      relayWithRetry(post, { signal: controller.signal, sleep, defaultRetryAfterSeconds: 2 })
    ).rejects.toThrow('aborted');

    // The point of the check: a cancelled upload must not push the bytes anyway.
    expect(post).toHaveBeenCalledTimes(1);
  });

  // AUDIT round-3 F3. `Retry-After` is remote input, and this retry fires on ANY 429 —
  // including one from a CDN or edge rate-limiter in front of us, which can legitimately
  // say "an hour". Unclamped, the hook would hold the user's File that long with the
  // tracked file stuck at `uploading`.
  it('clamps an absurd Retry-After to MAX_RETRY_AFTER_SECONDS', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: headers('3600') })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: headers() });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await relayWithRetry(post, {
      signal: liveSignal(),
      sleep,
      defaultRetryAfterSeconds: 2,
    });

    expect(sleep).toHaveBeenCalledWith(MAX_RETRY_AFTER_SECONDS * 1000);
    // Not the advertised hour, and not the 2s default either — the clamp specifically.
    expect(sleep).not.toHaveBeenCalledWith(3600 * 1000);
    expect(sleep).not.toHaveBeenCalledWith(2000);
  });

  it('still honours a Retry-After that is under the clamp', async () => {
    // Guards the clamp from becoming a flat override — `Math.min`, not a constant.
    const under = MAX_RETRY_AFTER_SECONDS - 1;
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: headers(String(under)) })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: headers() });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await relayWithRetry(post, { signal: liveSignal(), sleep, defaultRetryAfterSeconds: 2 });

    expect(sleep).toHaveBeenCalledWith(under * 1000);
  });

  // AUDIT round-3 F3, second half. The abort check used to run only AFTER the sleep
  // resolved, so a cancel during a long backoff was invisible until the timer expired —
  // the cancel button was inert for the whole wait. The wait now races the signal.
  it('rejects as soon as the signal aborts, without waiting out the backoff', async () => {
    const controller = new AbortController();
    const post = vi.fn().mockResolvedValue({ ok: false, status: 429, headers: headers('10') });
    // A sleep that never resolves: only the abort race can settle this.
    const sleep = vi.fn().mockImplementation(() => new Promise<void>(() => undefined));

    const pending = relayWithRetry(post, {
      signal: controller.signal,
      sleep,
      defaultRetryAfterSeconds: 2,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('aborted');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when the signal is ALREADY aborted at backoff time', async () => {
    const controller = new AbortController();
    controller.abort();
    const post = vi.fn().mockResolvedValue({ ok: false, status: 429, headers: headers('10') });
    const sleep = vi.fn().mockImplementation(() => new Promise<void>(() => undefined));

    await expect(
      relayWithRetry(post, { signal: controller.signal, sleep, defaultRetryAfterSeconds: 2 })
    ).rejects.toThrow('aborted');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
