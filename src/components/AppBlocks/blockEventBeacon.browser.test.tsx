import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BLOCK_EVENT_MAX_BODY_BYTES,
  BLOCK_EVENT_SESSION_CAP_PER_APP,
  buildBlockEventBodies,
  flushBlockEvents,
  recordBlockEvent,
  _internalsForTests,
  type BlockEventRow,
} from '~/components/AppBlocks/blockEventBeacon';

const ENDPOINT = '/api/track/block-event';
const SLOT = { appBlockId: 'apb_1', blockInstanceId: 'mbi_one' };

let beaconSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  _internalsForTests.reset();
  beaconSpy = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
  fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  // Every request this file caused went to the ingest path through one of the two stubs.
  for (const [url] of beaconSpy.mock.calls) expect(url).toBe(ENDPOINT);
  for (const [url] of fetchSpy.mock.calls) expect(url).toBe(ENDPOINT);
  _internalsForTests.reset();
  beaconSpy.mockRestore();
  fetchSpy.mockRestore();
  vi.useRealTimers();
});

async function beaconBodies(): Promise<Array<{ events: BlockEventRow[] }>> {
  return Promise.all(
    beaconSpy.mock.calls.map(async (call: unknown[]) => JSON.parse(await (call[1] as Blob).text()))
  );
}

function rowOfBytes(bytes: number, char = 'x'): BlockEventRow {
  const base = JSON.stringify({ ...SLOT, eventName: 'big', properties: { s: '' } });
  const charBytes = new TextEncoder().encode(char).length;
  return {
    ...SLOT,
    eventName: 'big',
    properties: { s: char.repeat((bytes - base.length) / charBytes) },
  };
}

describe('recordBlockEvent', () => {
  test('stamps the identity it is given and keeps only primitive property values', () => {
    recordBlockEvent(SLOT, {
      eventName: 'clicked',
      properties: { a: 'x', n: 1, b: false, z: null, obj: { k: 1 }, arr: [1], big: BigInt(1) },
      appBlockId: 'apb_spoofed',
      blockInstanceId: 'mbi_spoofed',
    });
    expect(_internalsForTests.queued()).toEqual([
      { ...SLOT, eventName: 'clicked', properties: { a: 'x', n: 1, b: false, z: null } },
    ]);
  });

  test('omits properties that are not a plain object and drops a payload without a string eventName', () => {
    recordBlockEvent(SLOT, { eventName: 'no_props' });
    recordBlockEvent(SLOT, { eventName: 'array_props', properties: [1, 2] });
    recordBlockEvent(SLOT, { eventName: 42 });
    recordBlockEvent(SLOT, null);
    recordBlockEvent(SLOT, 'clicked');
    expect(_internalsForTests.queued()).toEqual([
      { ...SLOT, eventName: 'no_props' },
      { ...SLOT, eventName: 'array_props' },
    ]);
    expect(_internalsForTests.dropped().invalid).toBe(3);
  });
});

describe('flushing', () => {
  test('flushes 10 s after the FIRST queued event; later events do not push it back', async () => {
    recordBlockEvent(SLOT, { eventName: 'a' });
    vi.advanceTimersByTime(5_000);
    recordBlockEvent(SLOT, { eventName: 'b' });
    vi.advanceTimersByTime(4_999);
    expect(beaconSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await beaconBodies()).toEqual([
      {
        events: [
          { ...SLOT, eventName: 'a' },
          { ...SLOT, eventName: 'b' },
        ],
      },
    ]);
    expect(_internalsForTests.queued()).toEqual([]);
  });

  test('flushes immediately at 50 rows', async () => {
    for (let i = 0; i < 50; i++) {
      recordBlockEvent({ ...SLOT, blockInstanceId: `mbi_${i % 5}` }, { eventName: `e${i}` });
    }
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    const [body] = await beaconBodies();
    expect(body.events).toHaveLength(50);
    expect(_internalsForTests.timerArmed()).toBe(false);
  });

  test('flushes on pagehide', async () => {
    recordBlockEvent(SLOT, { eventName: 'leaving' });
    window.dispatchEvent(new Event('pagehide'));
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await beaconBodies()).toEqual([{ events: [{ ...SLOT, eventName: 'leaving' }] }]);
  });

  test('flushes when the document becomes hidden, and not when it becomes visible', () => {
    recordBlockEvent(SLOT, { eventName: 'tab' });
    const spy = vi.spyOn(document, 'visibilityState', 'get');
    try {
      spy.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(beaconSpy).not.toHaveBeenCalled();
      spy.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(beaconSpy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('an empty queue sends nothing', () => {
    flushBlockEvents();
    window.dispatchEvent(new Event('pagehide'));
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('transport', () => {
  test('falls back to a keepalive fetch when sendBeacon refuses', () => {
    beaconSpy.mockReturnValue(false);
    recordBlockEvent(SLOT, { eventName: 'a' });
    flushBlockEvents();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual({ events: [{ ...SLOT, eventName: 'a' }] });
  });

  test('falls back to fetch when sendBeacon throws', () => {
    beaconSpy.mockImplementation(() => {
      throw new TypeError('beacon broke');
    });
    recordBlockEvent(SLOT, { eventName: 'a' });
    expect(() => flushBlockEvents()).not.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a fetch that throws or rejects never reaches the caller, and nothing is retried', async () => {
    beaconSpy.mockReturnValue(false);
    fetchSpy.mockImplementationOnce(() => {
      throw new TypeError('sync throw');
    });
    recordBlockEvent(SLOT, { eventName: 'a' });
    expect(() => flushBlockEvents()).not.toThrow();
    fetchSpy.mockRejectedValueOnce(new TypeError('network down'));
    recordBlockEvent(SLOT, { eventName: 'b' });
    expect(() => flushBlockEvents()).not.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(beaconSpy).toHaveBeenCalledTimes(2);
  });
});

describe('request splitting', () => {
  test('splits into bodies of at most 50 rows', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ ...SLOT, eventName: `e${i}` }));
    const { bodies, oversize } = buildBlockEventBodies(rows);
    expect(bodies.map((b) => JSON.parse(b).events.length)).toEqual([50, 50, 20]);
    expect(bodies.flatMap((b) => JSON.parse(b).events)).toEqual(rows);
    expect(oversize).toBe(0);
  });

  test('splits by measured UTF-8 bytes and drops a single row that cannot fit, counting it', () => {
    // Each row is ~40% of the limit in BYTES but ~13% in UTF-16 length (€ is 3 bytes), so a
    // length-based measure would put all of them in one over-limit body.
    const third = rowOfBytes(Math.floor(BLOCK_EVENT_MAX_BODY_BYTES * 0.4), '€');
    const tooBig = rowOfBytes(BLOCK_EVENT_MAX_BODY_BYTES + 10);
    const { bodies, oversize } = buildBlockEventBodies([third, third, tooBig, third, third]);
    expect(oversize).toBe(1);
    expect(bodies.map((b) => JSON.parse(b).events.length)).toEqual([2, 2]);
    for (const body of bodies) {
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(BLOCK_EVENT_MAX_BODY_BYTES);
    }
  });

  test('an event too large for one body is dropped when recorded, and counted', () => {
    recordBlockEvent(SLOT, rowOfBytes(BLOCK_EVENT_MAX_BODY_BYTES + 10));
    recordBlockEvent(SLOT, { eventName: 'small' });
    expect(_internalsForTests.queued()).toEqual([{ ...SLOT, eventName: 'small' }]);
    expect(_internalsForTests.dropped().oversize).toBe(1);
  });

  test('a flush sends every body when the queue needs more than one', async () => {
    const row = rowOfBytes(Math.floor(BLOCK_EVENT_MAX_BODY_BYTES * 0.4), '€');
    for (let i = 0; i < 3; i++) recordBlockEvent(SLOT, row);
    flushBlockEvents();
    const bodies = await beaconBodies();
    expect(bodies.map((b) => b.events.length)).toEqual([2, 1]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('client budget', () => {
  test('allows 10 events a second per block instance, independently per instance', () => {
    for (let i = 0; i < 15; i++) recordBlockEvent(SLOT, { eventName: 'burst' });
    recordBlockEvent({ ...SLOT, blockInstanceId: 'mbi_two' }, { eventName: 'other' });
    expect(_internalsForTests.queued()).toHaveLength(11);
    expect(_internalsForTests.dropped().rate_limited).toBe(5);

    vi.advanceTimersByTime(1_000);
    recordBlockEvent(SLOT, { eventName: 'later' });
    expect(_internalsForTests.queued()).toHaveLength(12);
    expect(_internalsForTests.dropped().rate_limited).toBe(5);
  });

  test('accepts at most 500 events per app per page session, without starving other apps', async () => {
    for (let second = 0; second < 60; second++) {
      for (let i = 0; i < 10; i++) recordBlockEvent(SLOT, { eventName: 'tick' });
      vi.advanceTimersByTime(1_000);
    }
    recordBlockEvent({ appBlockId: 'apb_2', blockInstanceId: 'mbi_x' }, { eventName: 'quiet' });
    flushBlockEvents();
    const rows = (await beaconBodies()).flatMap((body) => body.events);
    expect(rows.filter((r) => r.appBlockId === SLOT.appBlockId)).toHaveLength(
      BLOCK_EVENT_SESSION_CAP_PER_APP
    );
    expect(rows.filter((r) => r.appBlockId === 'apb_2')).toHaveLength(1);
    expect(_internalsForTests.dropped().session_cap).toBe(600 - BLOCK_EVENT_SESSION_CAP_PER_APP);
  });
});
