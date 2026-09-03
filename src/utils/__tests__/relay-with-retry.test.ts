import { describe, it, expect, vi } from 'vitest';
import { relayWithRetry } from '~/utils/upload-settlement';

// AUDIT round-2 F1. The relay sheds with 429 once its per-pod memory cap is full, and
// that cap sits deliberately BELOW the batch sizes callers use — the image dropzone
// defaults to 10 files uploaded concurrently against a cap of 8. So a shed is an
// expected outcome for exactly the population this fallback exists to rescue, and it
// must not be terminal: the settlement rule reports the ORIGINAL upload error rather
// than the relay's, so an unretried shed fails the file permanently while the server
// was saying "try again shortly".
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
});
