import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  flushBridgeMessages,
  recordBridgeMessage,
  _internalsForTests,
} from '~/components/AppBlocks/bridgeMessageBeacon';
import { BRIDGE_MESSAGE_COUNT_MAX } from '~/components/AppBlocks/bridgeLabels';
import { INVENTORY } from '~/components/AppBlocks/hostHandlerParity';

/**
 * The COALESCING half of the bridge beacon.
 *
 * 🔴 WHY THIS IS NOT A ONE-FOR-ONE MIRROR OF `/api/track/block-render`. That
 * beacon fires ONCE PER HOST MOUNT; this one sits on the inbound path of a bridge
 * whose own rate limit is 30 messages/sec/host, and a polling generator app is the
 * COMMON case (POLL_WORKFLOW on a tick), not the worst case. A request per message
 * would be a ~30 req/s/tab telemetry channel bolted onto a surface whose whole
 * argument is that it is cheap.
 *
 * 🔴 AND AGGREGATION IS LOSSLESS *HERE* BECAUSE THE QUANTITY IS A COUNT. N messages
 * over a flush window collapse to one row per distinct {app, type, host, outcome}
 * and the server increments BY that count, so the resulting prom series is
 * byte-identical to what a per-message beacon would have produced. That is the
 * property these tests pin — if `count` ever stopped riding along, the series would
 * silently under-report by the coalescing factor with nothing to indicate it.
 */

let beaconSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _internalsForTests.reset();
  // `sendBeacon` posts a Blob, whose text is only readable asynchronously — so
  // the WIRE BODY is asserted on the fetch-fallback path below (same serialized
  // string, one `JSON.stringify` call, no Blob round-trip), and the buffer's
  // own shape is asserted directly. Splitting it that way keeps every assertion
  // synchronous with the thing it is about.
  beaconSpy = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
});

afterEach(() => {
  beaconSpy.mockRestore();
  _internalsForTests.reset();
});

/**
 * Read what a flush WOULD send without going through the Blob round-trip: the
 * buffer is the thing under test, and `flushBridgeMessages` clears it, so capture
 * it immediately before.
 */
function bufferedRows() {
  return _internalsForTests
    .buffered()
    .map((e) => ({ key: `${e.appBlockId}|${e.type}|${e.host}|${e.outcome}`, count: e.count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('bridgeMessageBeacon coalescing', () => {
  test('N identical outcomes collapse to ONE row carrying count = N', async () => {
    for (let i = 0; i < 7; i++) {
      recordBridgeMessage({
        appBlockId: 'apb_1',
        type: 'POLL_WORKFLOW',
        host: 'PageBlockHost',
        outcome: 'handled',
      });
    }
    expect(bufferedRows()).toEqual([
      { key: 'apb_1|POLL_WORKFLOW|PageBlockHost|handled', count: 7 },
    ]);
  });

  test('distinct label sets stay distinct — coalescing must not merge series', async () => {
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'no_handler',
    });
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'no_handler',
    });
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    });
    recordBridgeMessage({
      appBlockId: 'apb_2',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'no_handler',
    });
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'PageBlockHost',
      outcome: 'no_handler',
    });
    expect(bufferedRows()).toEqual([
      { key: 'apb_1|GET_VIEWER|IframeHost|handled', count: 1 },
      { key: 'apb_1|GET_VIEWER|IframeHost|no_handler', count: 2 },
      { key: 'apb_1|GET_VIEWER|PageBlockHost|no_handler', count: 1 },
      { key: 'apb_2|GET_VIEWER|IframeHost|no_handler', count: 1 },
    ]);
  });

  test('flushing empties the buffer and posts exactly once', async () => {
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    });
    flushBridgeMessages();
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(_internalsForTests.buffered()).toEqual([]);
  });

  test('a flush with nothing buffered posts NOTHING — an empty batch is a 400', async () => {
    flushBridgeMessages();
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  test('the distinct-key cap flushes early rather than growing the map', async () => {
    // The bound exists so the browser-side Map cannot grow without limit. 🔴 The
    // keys have to be REAL protocol types: junk types now clamp to `other` before
    // they reach the map (see the clamp test below), so a loop over `JUNK_${i}`
    // produces ONE key and tests nothing — measured, it reported 0 flushes while
    // asserting 1. 32 inventory types x 2 hosts = 64 distinct keys.
    const types = Object.keys(INVENTORY).slice(0, 32);
    expect(types).toHaveLength(32);
    for (const host of ['IframeHost', 'PageBlockHost'] as const) {
      for (const type of types) {
        recordBridgeMessage({ appBlockId: 'apb_1', type, host, outcome: 'no_handler' });
      }
    }
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(_internalsForTests.buffered()).toEqual([]);
  });

  test('an unknown message type is CLAMPED into `other` before it can mint a key', async () => {
    // 🔴 THE BUFFER BOUND, AND IT IS NOT COSMETIC. `type` reaches here as the
    // block's own `data.type`, and the dispatcher's unhandled-message branch sits
    // AHEAD of the 30 msg/sec inbound limiter by design. Buffering it raw would
    // mint a key per junk message, trip the distinct-key flush every 64th, and
    // turn an inbound message flood into an outbound POST flood — and would put an
    // unbounded string in the body, which the server's `max(128)` rejects
    // WHOLESALE, destroying every legitimate count in the same batch.
    for (let i = 0; i < 40; i++) {
      recordBridgeMessage({
        appBlockId: 'apb_1',
        type: `JUNK_${i}`,
        host: 'IframeHost',
        outcome: 'no_handler',
      });
    }
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'X'.repeat(500),
      host: 'IframeHost',
      outcome: 'no_handler',
    });
    expect(bufferedRows()).toEqual([{ key: 'apb_1|other|IframeHost|no_handler', count: 41 }]);
    // POSITIVE CONTROL: the clamp can still say yes. A clamp that answered `other`
    // to everything would satisfy the assertion above.
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'no_handler',
    });
    expect(bufferedRows()).toEqual([
      { key: 'apb_1|GET_VIEWER|IframeHost|no_handler', count: 1 },
      { key: 'apb_1|other|IframeHost|no_handler', count: 41 },
    ]);
  });

  test('a count above the schema ceiling is CLAMPED, not left to 400 the whole batch', async () => {
    beaconSpy.mockReturnValue(false);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    for (let i = 0; i < BRIDGE_MESSAGE_COUNT_MAX + 5; i++) {
      recordBridgeMessage({
        appBlockId: 'apb_1',
        type: 'POLL_WORKFLOW',
        host: 'PageBlockHost',
        outcome: 'handled',
      });
    }
    expect(bufferedRows()).toEqual([
      { key: 'apb_1|POLL_WORKFLOW|PageBlockHost|handled', count: BRIDGE_MESSAGE_COUNT_MAX + 5 },
    ]);
    flushBridgeMessages();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events[0].count).toBe(BRIDGE_MESSAGE_COUNT_MAX);
    fetchSpy.mockRestore();
  });

  test('the flush TIMER is armed by a record and actually sends when it fires', async () => {
    // 🔴 WITHOUT THIS THE MODULE'S HEADLINE CLAIM IS UNTESTED. Under 64 distinct
    // keys — i.e. every real page — the timer and the lifecycle listeners are the
    // ONLY things that ever send a buffer. Deleting either left the previous
    // version of this suite fully green while the beacon delivered nothing.
    vi.useFakeTimers();
    try {
      recordBridgeMessage({
        appBlockId: 'apb_1',
        type: 'GET_VIEWER',
        host: 'IframeHost',
        outcome: 'handled',
      });
      expect(_internalsForTests.timerArmed()).toBe(true);
      expect(beaconSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(beaconSpy).toHaveBeenCalledTimes(1);
      expect(_internalsForTests.buffered()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('`visibilitychange: hidden` flushes — the ONLY path a mobile tab-switch takes', async () => {
    // 🔴 THE SIBLING OF `pagehide`, AND IT WAS UNTESTED. Deleting the
    // `visibilitychange` listener left the whole suite green while the module
    // header's "NO LOSS ON NAVIGATION" claim and the flush-window reasoning behind
    // `BRIDGE_MESSAGE_COUNT_MAX` both rest on it — and on mobile Safari a tab
    // switch fires ONLY this event.
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    });
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    spy.mockRestore();
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(_internalsForTests.buffered()).toEqual([]);
  });

  test('a visibilitychange to VISIBLE does not flush — the guard is on `hidden`', async () => {
    // The negative arm: without it, a listener that flushed on every
    // visibilitychange would satisfy the test above and quietly triple the request
    // rate on ordinary tab focus.
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    });
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    spy.mockRestore();
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(_internalsForTests.buffered()).toHaveLength(1);
  });

  test('`pagehide` flushes — the navigation path a plain fetch would lose', async () => {
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    });
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(_internalsForTests.buffered()).toEqual([]);
  });

  test('a failing sendBeacon falls back to keepalive fetch rather than dropping the batch', async () => {
    beaconSpy.mockReturnValue(false);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    });
    flushBridgeMessages();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/track/block-message');
    expect((init as RequestInit).keepalive).toBe(true);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      events: [
        {
          appBlockId: 'apb_1',
          type: 'GET_VIEWER',
          host: 'IframeHost',
          outcome: 'handled',
          count: 1,
        },
      ],
    });
    fetchSpy.mockRestore();
  });

  test('a rejected fetch cannot surface as an unhandled rejection', async () => {
    beaconSpy.mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    recordBridgeMessage({
      appBlockId: 'apb_1',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
    });
    expect(() => flushBridgeMessages()).not.toThrow();
    // Let the rejected promise settle inside the beacon's own `.catch`.
    await new Promise((r) => setTimeout(r, 10));
    fetchSpy.mockRestore();
  });
});
