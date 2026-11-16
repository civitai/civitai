import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueActivity, sendActivities } from '~/providers/ActivityReportingProvider';

// The server refuses an activity batch over 200 entries whole (400), so the provider must never
// send one. These pin the client half of that contract: chunks of at most 50, nothing lost between
// chunks, and a failed send does not stop later sends. Sizes are literals on purpose.

const fetchMock = vi.fn();

function sentBatches(): string[][] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).activities);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ActivityReportingProvider batching', () => {
  it('sends a large buffer as chunks of at most 50, in order, with nothing dropped', async () => {
    const names = Array.from({ length: 120 }, (_, i) => `tool-click:${i}`);
    for (const n of names) queueActivity(n);

    await sendActivities();

    const batches = sentBatches();
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(names);
  });

  it('keeps a click recorded while a request is in flight and sends it on the next flush', async () => {
    queueActivity('remix:image');
    fetchMock.mockImplementationOnce(async () => {
      queueActivity('copy:prompt');
      return { ok: true };
    });

    await sendActivities();
    // Not in the same flush: one flush sends only what was buffered when it started.
    expect(sentBatches()).toEqual([['remix:image']]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sentBatches()).toEqual([['remix:image'], ['copy:prompt']]);
  });

  it('sends one request per flush when every request lands a new click', async () => {
    // A click arrives during each of the first 5 requests. A flush that kept draining until the
    // buffer was empty would send 6 requests back to back (bounded here so it cannot spin forever).
    let clicksDuringRequests = 5;
    fetchMock.mockImplementation(async () => {
      if (clicksDuringRequests-- > 0) queueActivity('copy:prompt');
      return { ok: true };
    });
    queueActivity('remix:image');

    await sendActivities();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Drain what the test queued so the module-level buffer is empty for the next case.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sentBatches().flat()).toEqual(['remix:image', ...Array(5).fill('copy:prompt')]);
  });

  it('sends nothing when the buffer is empty', async () => {
    await sendActivities();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps sending after a request fails', async () => {
    queueActivity('remix:image');
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await sendActivities();

    queueActivity('copy:prompt');
    // The next scheduled flush, 10 s later.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sentBatches()).toEqual([['remix:image'], ['copy:prompt']]);
  });
});
