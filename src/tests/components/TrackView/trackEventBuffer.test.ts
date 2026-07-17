import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  enqueueTrackEvent,
  __trackBufferTestHooks as hooks,
} from '~/components/TrackView/trackEventBuffer';

/**
 * Coverage for the client telemetry coalescing buffer (Load-reduction B1).
 *
 * The buffer replaces one-tRPC-call-per-event for trackSearch/addAction with a
 * coalesced batch flushed to /api/track/batch. These tests verify the four flush
 * triggers and the no-loss-on-unload guarantee:
 *   - interval flush (timer),
 *   - size-cap flush,
 *   - visibilitychange:hidden flush via sendBeacon,
 *   - pagehide flush via sendBeacon (nothing buffered is lost on navigation),
 *   - order + payload preservation (transport changes, recorded shape does not),
 *   - fail-open: a failed flush re-queues events for the next flush (bounded).
 *
 * Runs in the node env with a hand-rolled fake DOM so the flush triggers are fully
 * deterministic (no reliance on a headless browser or jsdom event quirks).
 */

const { FLUSH_INTERVAL_MS, FLUSH_AT_SIZE, HARD_CAP } = hooks.constants;

function makeFakeDom() {
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
  const add = (type: string, cb: (e?: unknown) => void) => {
    (listeners[type] ??= []).push(cb);
  };
  const doc = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: add,
  };
  const win = { addEventListener: add };
  const fire = (type: string) => (listeners[type] ?? []).forEach((cb) => cb());
  return { doc, win, fire };
}

let sendBeacon: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let dom: ReturnType<typeof makeFakeDom>;

beforeEach(() => {
  hooks.reset();
  vi.useFakeTimers();

  dom = makeFakeDom();
  sendBeacon = vi.fn(() => true);
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));

  vi.stubGlobal('window', dom.win);
  vi.stubGlobal('document', dom.doc);
  vi.stubGlobal('navigator', { sendBeacon });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  hooks.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function lastFetchBody() {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

async function lastBeaconBody() {
  const call = sendBeacon.mock.calls.at(-1);
  const blob = call?.[1] as Blob;
  return JSON.parse(await blob.text());
}

describe('trackEventBuffer', () => {
  it('does not flush until the interval elapses, then flushes via fetch', async () => {
    enqueueTrackEvent({ kind: 'search', data: { query: 'cats', index: 'models' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hooks.pendingCount()).toBe(1);

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/track/batch');
    expect((init as RequestInit).keepalive).toBe(true);
    expect(await lastFetchBody()).toEqual([
      { kind: 'search', data: { query: 'cats', index: 'models' } },
    ]);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('flushes immediately once the size cap is reached (no timer wait)', async () => {
    for (let i = 0; i < FLUSH_AT_SIZE; i++) {
      enqueueTrackEvent({ kind: 'action', data: { type: 'AwardBounty_Click' } });
    }
    // Cap reached -> flushed synchronously, before any timer advance.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await lastFetchBody();
    expect(body).toHaveLength(FLUSH_AT_SIZE);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('preserves event order and the exact per-event payload across a batch', async () => {
    enqueueTrackEvent({ kind: 'action', data: { type: 'Tip_Click', details: { toUserId: 7 } } });
    enqueueTrackEvent({ kind: 'search', data: { query: 'dogs', index: 'images', filters: { a: 1 } } });
    enqueueTrackEvent({ kind: 'action', data: { type: 'AddToBounty_Confirm' } });

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(await lastFetchBody()).toEqual([
      { kind: 'action', data: { type: 'Tip_Click', details: { toUserId: 7 } } },
      { kind: 'search', data: { query: 'dogs', index: 'images', filters: { a: 1 } } },
      { kind: 'action', data: { type: 'AddToBounty_Confirm' } },
    ]);
  });

  it('flushes via sendBeacon (not fetch) on visibilitychange -> hidden', async () => {
    enqueueTrackEvent({ kind: 'search', data: { query: 'x', index: 'models' } });

    dom.doc.visibilityState = 'hidden';
    dom.fire('visibilitychange');

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const [beaconUrl, blob] = sendBeacon.mock.calls[0];
    expect(beaconUrl).toBe('/api/track/batch');
    expect((blob as Blob).type).toBe('application/json');
    expect(await lastBeaconBody()).toEqual([{ kind: 'search', data: { query: 'x', index: 'models' } }]);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('does NOT flush on visibilitychange -> visible', () => {
    enqueueTrackEvent({ kind: 'search', data: { query: 'x', index: 'models' } });
    dom.doc.visibilityState = 'visible';
    dom.fire('visibilitychange');
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(hooks.pendingCount()).toBe(1);
  });

  it('loses no buffered events on pagehide — flushes them via sendBeacon', async () => {
    // The core no-loss guarantee: events buffered right before navigation are
    // delivered by the unload-safe beacon, not dropped.
    enqueueTrackEvent({ kind: 'action', data: { type: 'AwardBounty_Click' } });
    enqueueTrackEvent({ kind: 'search', data: { query: 'q', index: 'models' } });
    expect(hooks.pendingCount()).toBe(2);

    dom.fire('pagehide');

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(await lastBeaconBody()).toHaveLength(2);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('is a no-op flush when the buffer is empty (idempotent unload handlers)', () => {
    dom.fire('pagehide');
    dom.doc.visibilityState = 'hidden';
    dom.fire('visibilitychange');
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fail-open: re-queues events and retries on the next flush when a flush fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false }); // first flush rejected by server
    enqueueTrackEvent({ kind: 'search', data: { query: 'retry', index: 'models' } });

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    // Let the post() promise + re-queue microtask settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Event was NOT silently lost — it's back in the buffer.
    expect(hooks.pendingCount()).toBe(1);

    // Next interval retries (fetch now succeeds by default).
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await lastFetchBody()).toEqual([
      { kind: 'search', data: { query: 'retry', index: 'models' } },
    ]);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('bounds re-queued events to the hard cap (drops oldest overflow, never grows unbounded)', async () => {
    // Force every flush to fail so events accumulate, and keep enqueuing past the
    // hard cap. The buffer must never exceed HARD_CAP.
    fetchMock.mockResolvedValue({ ok: false });
    for (let i = 0; i < HARD_CAP + FLUSH_AT_SIZE; i++) {
      enqueueTrackEvent({ kind: 'search', data: { query: `q${i}`, index: 'models' } });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(hooks.pendingCount()).toBeLessThanOrEqual(HARD_CAP);
  });
});
