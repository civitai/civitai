// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

// React 18.3 exposes `act` on the `react` export; borrow the typed signature.
const act = (React as unknown as { act: typeof actType }).act;

/**
 * INTEGRATION coverage for the `useTrackEvent` -> `enqueueTrackEvent` wiring
 * (Load-reduction B1).
 *
 * The sibling `trackEventBuffer.test.ts` drives the buffer in ISOLATION — it
 * calls `enqueueTrackEvent` directly. That leaves ONE seam untested: whether the
 * `useTrackEvent` React hook (the entrypoint every trackSearch/trackAction call
 * site actually uses) still routes low-value events INTO the buffer, arms the
 * interval, and registers the unload listeners. A regression there — the hook
 * dropping the enqueue call, or tagging a search as the wrong `kind` — would sail
 * past the isolated buffer tests while silently breaking coalesced telemetry in
 * the real app. These tests exercise the FULL chain through the real hook:
 *   hook handler -> real enqueueTrackEvent -> buffer -> interval/immediate flush
 *   + the visibilitychange/pagehide unload listeners.
 */

// trackShare stays a per-event tRPC mutation; mock only enough for the hook to
// instantiate. The batched search/action paths do NOT touch tRPC.
vi.mock('~/utils/trpc', () => ({
  trpc: {
    track: {
      trackShare: { useMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }) },
    },
  },
}));

// Real hook + real buffer (NOT mocked) — this is the wiring under test.
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { __trackBufferTestHooks as hooks } from '~/components/TrackView/trackEventBuffer';

const { FLUSH_INTERVAL_MS } = hooks.constants;

let fetchMock: ReturnType<typeof vi.fn>;
let beaconMock: ReturnType<typeof vi.fn>;

function renderTrackEvent() {
  const container = document.createElement('div');
  const root = createRoot(container);
  const ref: { current: ReturnType<typeof useTrackEvent> | undefined } = { current: undefined };
  function Probe() {
    ref.current = useTrackEvent();
    return null;
  }
  act(() => root.render(React.createElement(Probe)));
  return ref;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  hooks.reset();
  vi.useFakeTimers();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  beaconMock = vi.fn(() => true);
  vi.stubGlobal('fetch', fetchMock);
  // happy-dom's navigator has no sendBeacon; define one so the unload path can use it.
  Object.defineProperty(navigator, 'sendBeacon', { value: beaconMock, configurable: true, writable: true });
});

afterEach(() => {
  hooks.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function lastFetchBody() {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

describe('useTrackEvent -> buffer wiring', () => {
  it('a low-value trackSearch enqueues into the buffer and flushes on the interval as kind:"search"', () => {
    const api = renderTrackEvent();

    void api.current!.trackSearch({ query: 'cats', index: 'models' });

    // Enqueued, coalescing — no request yet, interval armed.
    expect(hooks.pendingCount()).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/track/batch');
    // Transport is batched; the recorded shape is the UNCHANGED per-event input.
    expect(lastFetchBody()).toEqual([{ kind: 'search', data: { query: 'cats', index: 'models' } }]);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('a low-value trackAction (non-immediate) enqueues as kind:"action" and coalesces (no synchronous flush)', () => {
    const api = renderTrackEvent();

    void api.current!.trackAction({ type: 'Image_Remix_Click', details: { imageId: 1 } } as never);

    expect(hooks.pendingCount()).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // batched, not immediate

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastFetchBody()).toEqual([
      { kind: 'action', data: { type: 'Image_Remix_Click', details: { imageId: 1 } } },
    ]);
  });

  it('an immediate high-value trackAction (Generator_Submit) flushes synchronously through the hook (no interval wait)', () => {
    const api = renderTrackEvent();

    void api.current!.trackAction({ type: 'Generator_Submit' } as never);

    // Fired in the same tick — no timer advance needed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastFetchBody()).toEqual([{ kind: 'action', data: { type: 'Generator_Submit' } }]);
    expect(hooks.pendingCount()).toBe(0);
  });

  it('registers the unload listeners so a buffered low-value event flushes via sendBeacon on pagehide', () => {
    const api = renderTrackEvent();

    void api.current!.trackSearch({ query: 'dogs', index: 'images' });
    expect(hooks.pendingCount()).toBe(1);
    expect(beaconMock).not.toHaveBeenCalled();

    // The pagehide listener must have been registered on the first enqueue (via the
    // hook) — firing it should beacon the buffered event out before the interval.
    window.dispatchEvent(new Event('pagehide'));

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(beaconMock.mock.calls[0][0]).toBe('/api/track/batch');
    expect(hooks.pendingCount()).toBe(0);
  });

  it('flushes a buffered event on visibilitychange:hidden (mobile-reliable unload signal)', () => {
    const api = renderTrackEvent();

    void api.current!.trackSearch({ query: 'birds', index: 'models' });
    expect(hooks.pendingCount()).toBe(1);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(beaconMock.mock.calls[0][0]).toBe('/api/track/batch');
    expect(hooks.pendingCount()).toBe(0);
  });
});
