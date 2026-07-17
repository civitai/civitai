import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  enqueueTrackEvent,
  __trackBufferTestHooks as hooks,
} from '~/components/TrackView/trackEventBuffer';
import { isImmediateFlushTrackEvent } from '~/server/schema/track.schema';
import type { TrackActionInput, TrackBatchEvent } from '~/server/schema/track.schema';

/**
 * Coverage for the client telemetry coalescing buffer (Load-reduction B1).
 *
 * The buffer replaces one-tRPC-call-per-event for trackSearch/addAction with a
 * coalesced batch flushed to /api/track/batch. These tests verify the flush
 * triggers, the no-loss guarantees, and the oversized-batch handling:
 *   - interval flush (timer),
 *   - size-cap flush,
 *   - immediate flush for money/conversion + compliance (CSAM) events,
 *   - visibilitychange:hidden flush via sendBeacon,
 *   - pagehide flush via sendBeacon (nothing buffered is lost on navigation),
 *   - order + payload preservation (transport changes, recorded shape does not),
 *   - fail-open: a failed flush (incl. a failed immediate high-value flush)
 *     re-queues events for the next flush (bounded),
 *   - sendBeacon returning false (over the ~64KB cap) falls back to keepalive
 *     fetch instead of dropping, and oversized batches are split into sub-batches.
 *
 * Runs in the node env with a hand-rolled fake DOM so the flush triggers are fully
 * deterministic (no reliance on a headless browser or jsdom event quirks).
 */

const { FLUSH_INTERVAL_MS, FLUSH_AT_SIZE, HARD_CAP, MAX_BEACON_BYTES } = hooks.constants;

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
    // All low-value so the batch coalesces on the interval (order under test here).
    enqueueTrackEvent({ kind: 'action', data: { type: 'Tip_Click', details: { toUserId: 7 } } });
    enqueueTrackEvent({ kind: 'search', data: { query: 'dogs', index: 'images', filters: { a: 1 } } });
    enqueueTrackEvent({ kind: 'action', data: { type: 'AddToBounty_Click' } });

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(await lastFetchBody()).toEqual([
      { kind: 'action', data: { type: 'Tip_Click', details: { toUserId: 7 } } },
      { kind: 'search', data: { query: 'dogs', index: 'images', filters: { a: 1 } } },
      { kind: 'action', data: { type: 'AddToBounty_Click' } },
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

  it('immediately flushes a high-value action event (no interval wait)', async () => {
    // PurchaseFunds_Confirm is a conversion/monetization event — it must leave in
    // the same tick, not wait for the 3s interval (a crash before the interval
    // would lose it). No timers are advanced here.
    enqueueTrackEvent({
      kind: 'action',
      data: { type: 'PurchaseFunds_Confirm', details: { buzzAmount: 100, unitAmount: 1, method: 'card' } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hooks.pendingCount()).toBe(0);
    expect(await lastFetchBody()).toEqual([
      { kind: 'action', data: { type: 'PurchaseFunds_Confirm', details: { buzzAmount: 100, unitAmount: 1, method: 'card' } } },
    ]);
  });

  it('a high-value flush carries already-buffered low-value events (single transport, order preserved)', async () => {
    // A low-value event sits in the buffer; a following high-value event forces the
    // flush and takes the buffered low-value event with it, in order.
    enqueueTrackEvent({ kind: 'search', data: { query: 'held', index: 'models' } });
    expect(fetchMock).not.toHaveBeenCalled();

    enqueueTrackEvent({ kind: 'action', data: { type: 'Tip_Confirm', details: { toUserId: 1, amount: 5 } } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await lastFetchBody()).toEqual([
      { kind: 'search', data: { query: 'held', index: 'models' } },
      { kind: 'action', data: { type: 'Tip_Confirm', details: { toUserId: 1, amount: 5 } } },
    ]);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('does NOT immediately flush a low-value action event (still coalesces on the interval)', async () => {
    enqueueTrackEvent({ kind: 'action', data: { type: 'Tip_Click', details: { toUserId: 2 } } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hooks.pendingCount()).toBe(1);

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never immediately flushes a trackSearch event (searches are the batched bulk)', () => {
    enqueueTrackEvent({ kind: 'search', data: { query: 'x', index: 'models' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hooks.pendingCount()).toBe(1);
  });

  it('immediately flushes the compliance-critical CSAM_Help_Triggered event', async () => {
    // Child-safety signal — must never sit buffered or be crash-losable.
    enqueueTrackEvent({
      kind: 'action',
      data: { type: 'CSAM_Help_Triggered', details: { query: 'redacted' } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hooks.pendingCount()).toBe(0);
    expect(await lastFetchBody()).toEqual([
      { kind: 'action', data: { type: 'CSAM_Help_Triggered', details: { query: 'redacted' } } },
    ]);
  });

  it('re-queues a FAILED high-value immediate flush (conversion event not lost)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false }); // the immediate flush is rejected
    enqueueTrackEvent({
      kind: 'action',
      data: { type: 'Generator_Submit', details: { fromAction: 'create' } },
    });
    // Let the immediate flush's post + re-queue microtask settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The conversion event was re-queued, not dropped.
    expect(hooks.pendingCount()).toBe(1);

    // The re-queue armed the interval timer; next flush (fetch ok) delivers it.
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await lastFetchBody()).toEqual([
      { kind: 'action', data: { type: 'Generator_Submit', details: { fromAction: 'create' } } },
    ]);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('handles sendBeacon returning false on unload by falling back to keepalive fetch (no silent loss)', async () => {
    sendBeacon.mockReturnValue(false); // beacon refused (e.g. over the ~64KB cap)
    enqueueTrackEvent({ kind: 'search', data: { query: 'q', index: 'models' } });

    dom.fire('pagehide');
    await vi.advanceTimersByTimeAsync(0);

    // Beacon was attempted, refused, then the keepalive fetch fallback carried it.
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(true);
    expect(await lastFetchBody()).toEqual([{ kind: 'search', data: { query: 'q', index: 'models' } }]);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('splits a batch larger than the beacon cap into multiple sub-batch sends', async () => {
    // Two events each ~ half the cap in size -> two chunks -> two beacons on unload,
    // each under the cap. Proves oversized batches aren't sent as one over-cap blob.
    const big = 'x'.repeat(Math.floor(MAX_BEACON_BYTES * 0.7));
    enqueueTrackEvent({ kind: 'search', data: { query: big, index: 'models' } });
    enqueueTrackEvent({ kind: 'search', data: { query: big, index: 'models' } });

    dom.fire('pagehide');
    await vi.advanceTimersByTimeAsync(0);

    // Two separate beacon sends (one per chunk), not one over-cap request.
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    for (const call of sendBeacon.mock.calls) {
      const blob = call[1] as Blob;
      expect(blob.size).toBeLessThanOrEqual(MAX_BEACON_BYTES);
      const parsed = JSON.parse(await blob.text());
      expect(parsed).toHaveLength(1);
    }
    expect(hooks.pendingCount()).toBe(0);
  });

  it('chunkEvents keeps each chunk within the byte cap and preserves order', () => {
    const big = 'y'.repeat(Math.floor(MAX_BEACON_BYTES * 0.6));
    const events: TrackBatchEvent[] = [
      { kind: 'search', data: { query: `${big}1`, index: 'models' } },
      { kind: 'search', data: { query: `${big}2`, index: 'models' } },
      { kind: 'search', data: { query: `${big}3`, index: 'models' } },
    ];
    const chunks = hooks.chunkEvents(events);
    expect(chunks.length).toBeGreaterThan(1);
    // Order preserved across the flattened chunks.
    expect(chunks.flat()).toEqual(events);
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(MAX_BEACON_BYTES);
    }
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

describe('isImmediateFlushTrackEvent classification', () => {
  const action = (type: TrackActionInput['type']) =>
    ({ kind: 'action', data: { type } } as any);

  it('classifies money/conversion AND compliance action types as immediate-flush', () => {
    const immediate: TrackActionInput['type'][] = [
      // money / conversion
      'Generator_Submit',
      'PurchaseFunds_Confirm',
      'PurchaseFunds_Cancel',
      'NotEnoughFunds',
      'Tip_Confirm',
      'AddToBounty_Confirm',
      'AwardBounty_Confirm',
      'Membership_Cancel',
      'Membership_Downgrade',
      // compliance / safety
      'CSAM_Help_Triggered',
    ];
    for (const type of immediate) {
      expect(isImmediateFlushTrackEvent(action(type))).toBe(true);
    }
  });

  it('classifies high-volume/non-critical action types as batched (not immediate)', () => {
    const batched: TrackActionInput['type'][] = [
      'AddToBounty_Click',
      'AwardBounty_Click',
      'Tip_Click',
      'TipInteractive_Click',
      'TipInteractive_Cancel',
      'LoginRedirect',
      'ProfanitySearch',
      'Model_Create_Click',
      'Image_Remix_Click',
    ];
    for (const type of batched) {
      expect(isImmediateFlushTrackEvent(action(type))).toBe(false);
    }
  });

  it('never classifies a search event as immediate-flush', () => {
    expect(isImmediateFlushTrackEvent({ kind: 'search', data: { query: 'x', index: 'models' } })).toBe(false);
  });
});
