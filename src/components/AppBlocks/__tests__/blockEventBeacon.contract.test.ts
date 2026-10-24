import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BLOCK_EVENT_BATCH_MAX, blockEventBatchSchema } from '~/server/schema/track.schema';
import {
  BLOCK_EVENT_BATCH_ROWS,
  BLOCK_EVENT_MAX_BODY_BYTES,
  createBlockEventRecorder,
  flushBlockEvents,
  _internalsForTests,
} from '~/components/AppBlocks/blockEventBeacon';

/**
 * The batcher's request bodies against the MERGED ingest's own batch schema and body limit. The
 * schema leaves `eventName` and `properties` unchecked (the ingest filters them against the
 * manifest), so it pins the identity fields and the row count.
 * Node has no `window`, so the browser globals the batcher touches are stubbed; the request is
 * captured from the stubbed `fetch` and never sent.
 */

const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
  Promise.resolve(new Response(null))
);

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { sendBeacon: () => false });
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  _internalsForTests.reset();
});

afterEach(() => {
  _internalsForTests.reset();
  vi.unstubAllGlobals();
});

function sentBodies(): unknown[] {
  return fetchSpy.mock.calls.map(([url, init]) => {
    expect(url).toBe('/api/track/block-event');
    return JSON.parse(init.body as string);
  });
}

describe('blockEventBeacon request bodies satisfy the ingest contract', () => {
  test('a representative batch from both host shapes parses under blockEventBatchSchema', () => {
    const page = { appBlockId: 'apb_7f3', blockInstanceId: 'page_apb_7f3' };
    const slot = { appBlockId: 'apb_9c1', blockInstanceId: 'mbi_4d2' };
    const recordPage = createBlockEventRecorder(page);
    const recordSlot = createBlockEventRecorder(slot);
    recordPage({ eventName: 'run_started', properties: { mode: 'fast', n: 2 } });
    recordPage({ eventName: 'run_finished', properties: { ok: true, nested: { deep: [1] } } });
    recordSlot({ eventName: 'opened' });
    recordSlot({ eventName: 'Not Declared!', properties: { x: null } });
    flushBlockEvents();

    const bodies = sentBodies();
    expect(bodies).toHaveLength(1);
    const expected = [
      { ...page, eventName: 'run_started', properties: { mode: 'fast', n: 2 } },
      // Forwarded as given: the ingest classifies a wrongly typed value as `invalid_value`.
      { ...page, eventName: 'run_finished', properties: { ok: true, nested: { deep: [1] } } },
      { ...slot, eventName: 'opened' },
      { ...slot, eventName: 'Not Declared!', properties: { x: null } },
    ];
    // The raw body, before zod strips unknown keys: nothing beyond the four fields is sent.
    expect(bodies[0]).toEqual({ events: expected });
    const parsed = blockEventBatchSchema.safeParse(bodies[0]);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.events).toEqual(expected);
  });

  test('a full flush of 120 events is sent as bodies that each parse', () => {
    const recorders = Array.from({ length: 12 }, (_, i) =>
      createBlockEventRecorder({ appBlockId: 'apb_1', blockInstanceId: `mbi_${i}` })
    );
    for (let i = 0; i < 120; i++) recorders[i % 12]({ eventName: `e${i}` });
    flushBlockEvents();
    const bodies = sentBodies();
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of bodies) expect(blockEventBatchSchema.safeParse(body).success).toBe(true);
  });

  test('negative control: the schema rejects shapes the batcher must never send', () => {
    const row = { appBlockId: 'apb_1', blockInstanceId: 'mbi_1', eventName: 'a' };
    expect(blockEventBatchSchema.safeParse({ events: [row] }).success).toBe(true);
    expect(
      blockEventBatchSchema.safeParse({ events: [{ ...row, blockInstanceId: '' }] }).success
    ).toBe(false);
    expect(
      blockEventBatchSchema.safeParse({ events: [{ eventName: 'a', blockInstanceId: 'mbi_1' }] })
        .success
    ).toBe(false);
    expect(
      blockEventBatchSchema.safeParse({ events: Array(BLOCK_EVENT_BATCH_MAX + 1).fill(row) })
        .success
    ).toBe(false);
    expect(blockEventBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });

  test('the batcher row cap equals the schema batch max', () => {
    expect(BLOCK_EVENT_BATCH_ROWS).toBe(BLOCK_EVENT_BATCH_MAX);
  });

  test("the batcher body cap is below the route's body-size limit", () => {
    const route = readFileSync(join(__dirname, '../../../pages/api/track/block-event.ts'), 'utf8');
    const match = route.match(/sizeLimit:\s*'(\d+)kb'/);
    expect(match, 'route sizeLimit not found in the expected form').not.toBeNull();
    expect(BLOCK_EVENT_MAX_BODY_BYTES).toBeLessThan(Number(match?.[1]) * 1024);
  });
});
