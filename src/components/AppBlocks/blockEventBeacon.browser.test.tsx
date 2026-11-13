import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BLOCK_EVENT_CAP_PER_MOUNT,
  BLOCK_EVENT_MAX_BODY_BYTES,
  createBlockEventRecorder,
  flushBlockEvents,
  _internalsForTests,
  type BlockEventIdentity,
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

/** A payload whose row serialises to about `bytes` UTF-8 bytes. */
function payloadOfBytes(bytes: number, char = 'x', identity: BlockEventIdentity = SLOT) {
  const base = JSON.stringify({ ...identity, eventName: 'big', properties: { s: '' } });
  const charBytes = new TextEncoder().encode(char).length;
  return {
    eventName: 'big',
    properties: { s: char.repeat(Math.floor((bytes - base.length) / charBytes)) },
  };
}

describe('the recorder', () => {
  test('stamps the identity it was created with and forwards properties as given', () => {
    const record = createBlockEventRecorder(SLOT);
    record({
      eventName: 'clicked',
      properties: { a: 'x', n: 1, b: false, z: null, obj: { k: 1 }, arr: [1] },
      appBlockId: 'apb_spoofed',
      blockInstanceId: 'mbi_spoofed',
    });
    expect(_internalsForTests.queued()).toEqual([
      {
        ...SLOT,
        eventName: 'clicked',
        properties: { a: 'x', n: 1, b: false, z: null, obj: { k: 1 }, arr: [1] },
      },
    ]);
  });

  test('omits properties that are not a plain object and drops a payload without a string eventName', () => {
    const record = createBlockEventRecorder(SLOT);
    record({ eventName: 'no_props' });
    record({ eventName: 'array_props', properties: [1, 2] });
    record({ eventName: 42 });
    record(null);
    record('clicked');
    expect(_internalsForTests.queued()).toEqual([
      { ...SLOT, eventName: 'no_props' },
      { ...SLOT, eventName: 'array_props' },
    ]);
  });

  test('drops, without throwing, a payload JSON cannot serialise', () => {
    const record = createBlockEventRecorder(SLOT);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => record({ eventName: 'big', properties: { n: BigInt(1) } })).not.toThrow();
    expect(() => record({ eventName: 'loop', properties: cyclic })).not.toThrow();
    record({ eventName: 'fine' });
    expect(_internalsForTests.queued()).toEqual([{ ...SLOT, eventName: 'fine' }]);
  });

  test("keeps only the serialised row, not the block's properties object", () => {
    const record = createBlockEventRecorder(SLOT);
    record({ eventName: 'buffer', properties: { buf: new ArrayBuffer(20 * 1024 * 1024) } });
    expect(_internalsForTests.entryKeys()).toEqual([['json', 'bytes']]);
    expect(_internalsForTests.queued()).toEqual([
      { ...SLOT, eventName: 'buffer', properties: { buf: {} } },
    ]);
  });

  test('drops an event too large for one body', () => {
    const record = createBlockEventRecorder(SLOT);
    record(payloadOfBytes(BLOCK_EVENT_MAX_BODY_BYTES + 10));
    record({ eventName: 'small' });
    expect(_internalsForTests.queued()).toEqual([{ ...SLOT, eventName: 'small' }]);
  });
});

describe('flushing', () => {
  test('flushes 10 s after the FIRST queued event; later events do not push it back', async () => {
    const record = createBlockEventRecorder(SLOT);
    record({ eventName: 'a' });
    vi.advanceTimersByTime(5_000);
    record({ eventName: 'b' });
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
    const recorders = Array.from({ length: 5 }, (_, i) =>
      createBlockEventRecorder({ ...SLOT, blockInstanceId: `mbi_${i}` })
    );
    for (let i = 0; i < 50; i++) recorders[i % 5]({ eventName: `e${i}` });
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    const [body] = await beaconBodies();
    expect(body.events).toHaveLength(50);
    expect(_internalsForTests.timerArmed()).toBe(false);
  });

  test('flushes on pagehide', async () => {
    createBlockEventRecorder(SLOT)({ eventName: 'leaving' });
    window.dispatchEvent(new Event('pagehide'));
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await beaconBodies()).toEqual([{ events: [{ ...SLOT, eventName: 'leaving' }] }]);
  });

  test('flushes when the document becomes hidden, and not when it becomes visible', () => {
    createBlockEventRecorder(SLOT)({ eventName: 'tab' });
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

describe('request splitting', () => {
  test('a busy queue is sent in bodies of at most 50 rows', async () => {
    const recorders = Array.from({ length: 12 }, (_, i) =>
      createBlockEventRecorder({ ...SLOT, blockInstanceId: `mbi_${i}` })
    );
    // 49 rows stay below the immediate-flush threshold.
    for (let i = 0; i < 49; i++) recorders[i % 12]({ eventName: `e${i}` });
    flushBlockEvents();
    for (let i = 0; i < 49; i++) recorders[i % 12]({ eventName: `f${i}` });
    vi.advanceTimersByTime(1_000);
    for (let i = 0; i < 2; i++) recorders[i]({ eventName: `g${i}` });
    flushBlockEvents();
    expect((await beaconBodies()).map((b) => b.events.length)).toEqual([49, 50, 1]);
  });

  test('splits by measured UTF-8 bytes, and a flush sends every body', async () => {
    // Each row is ~40% of the limit in BYTES but ~13% in UTF-16 length (€ is 3 bytes), so a
    // length-based measure would put all of them in one over-limit body.
    const record = createBlockEventRecorder(SLOT);
    const payload = payloadOfBytes(Math.floor(BLOCK_EVENT_MAX_BODY_BYTES * 0.4), '€');
    for (let i = 0; i < 5; i++) record(payload);
    flushBlockEvents();
    const sent: Blob[] = beaconSpy.mock.calls.map((call: unknown[]) => call[1] as Blob);
    expect(sent.map((blob) => blob.size).every((n) => n <= BLOCK_EVENT_MAX_BODY_BYTES)).toBe(true);
    expect((await beaconBodies()).map((b) => b.events.length)).toEqual([2, 2, 1]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a page-exit flush sends one body at most and drops the rest', async () => {
    const record = createBlockEventRecorder(SLOT);
    const payload = payloadOfBytes(Math.floor(BLOCK_EVENT_MAX_BODY_BYTES * 0.4), '€');
    for (let i = 0; i < 5; i++) record(payload);
    window.dispatchEvent(new Event('pagehide'));
    expect((await beaconBodies()).map((b) => b.events.length)).toEqual([2]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(_internalsForTests.queued()).toEqual([]);
  });
});

describe('transport', () => {
  test('falls back to a keepalive fetch when sendBeacon refuses', () => {
    beaconSpy.mockReturnValue(false);
    createBlockEventRecorder(SLOT)({ eventName: 'a' });
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
    createBlockEventRecorder(SLOT)({ eventName: 'a' });
    expect(() => flushBlockEvents()).not.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a fetch that throws or rejects never reaches the caller, and nothing is retried', async () => {
    beaconSpy.mockReturnValue(false);
    const record = createBlockEventRecorder(SLOT);
    fetchSpy.mockImplementationOnce(() => {
      throw new TypeError('sync throw');
    });
    record({ eventName: 'a' });
    expect(() => flushBlockEvents()).not.toThrow();
    fetchSpy.mockRejectedValueOnce(new TypeError('network down'));
    record({ eventName: 'b' });
    expect(() => flushBlockEvents()).not.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(beaconSpy).toHaveBeenCalledTimes(2);
  });
});

describe('budget per host mount', () => {
  test('allows 10 events a second per mount, independently per mount', () => {
    const record = createBlockEventRecorder(SLOT);
    for (let i = 0; i < 15; i++) record({ eventName: 'burst' });
    createBlockEventRecorder({ ...SLOT, blockInstanceId: 'mbi_two' })({ eventName: 'other' });
    expect(_internalsForTests.queued()).toHaveLength(11);

    vi.advanceTimersByTime(1_000);
    record({ eventName: 'later' });
    expect(_internalsForTests.queued()).toHaveLength(12);
  });

  test('oversize events spend the budget before they are serialised', () => {
    const record = createBlockEventRecorder(SLOT);
    const oversize = payloadOfBytes(BLOCK_EVENT_MAX_BODY_BYTES + 10);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for (let i = 0; i < 50; i++) record(oversize);
      expect(stringify).toHaveBeenCalledTimes(10);
    } finally {
      stringify.mockRestore();
    }
    record({ eventName: 'valid_after_flood' });
    expect(_internalsForTests.queued()).toEqual([]);
  });

  test('caps a mount at 500 events; a remount of the same app starts fresh', async () => {
    const first = createBlockEventRecorder(SLOT);
    // A second, simultaneous mount of the SAME app keeps its own budget.
    const sibling = createBlockEventRecorder({ ...SLOT, blockInstanceId: 'mbi_sibling' });
    for (let second = 0; second < 60; second++) {
      for (let i = 0; i < 10; i++) first({ eventName: 'tick' });
      vi.advanceTimersByTime(1_000);
    }
    first({ eventName: 'over_cap' });
    sibling({ eventName: 'sibling' });
    const remount = createBlockEventRecorder(SLOT);
    remount({ eventName: 'after_remount' });
    flushBlockEvents();

    const rows = (await beaconBodies()).flatMap((body) => body.events);
    expect(rows.filter((r) => r.eventName === 'tick')).toHaveLength(BLOCK_EVENT_CAP_PER_MOUNT);
    expect(rows.filter((r) => r.eventName === 'over_cap')).toHaveLength(0);
    expect(rows.filter((r) => r.eventName === 'sibling')).toHaveLength(1);
    expect(rows.filter((r) => r.eventName === 'after_remount')).toHaveLength(1);
  });
});
