import { describe, expect, it } from 'vitest';
import {
  buildMediaUploadBatchConfirmCopy,
  buildMediaUploadBatchResults,
  mediaUploadBatchStartError,
  resolveMediaUploadBatchRequest,
  runWithConcurrency,
  type MediaUploadBatchPlan,
} from './mediaUploadBatchLogic';
import { MEDIA_UPLOAD_WINDOW_LIMITS, processMediaUploadBytes } from './mediaUploadLogic';

/**
 * `OPEN_MEDIA_UPLOAD_BATCH`'s pure half. The per-item checks are compared against the single bytes
 * upload's own decision for the same bytes, so the two cannot drift; the strings are also pinned as
 * literals, because the SDK's mock host copies them.
 */

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00];
const WAV = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45];

function buf(head: number[], size = head.length): ArrayBuffer {
  const u8 = new Uint8Array(size);
  u8.set(head);
  return u8.buffer;
}

const req = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  requestId: 'rq_batch',
  purpose: 'generationSource',
  items,
  ...extra,
});

function plan(raw: unknown): MediaUploadBatchPlan {
  const decision = resolveMediaUploadBatchRequest(raw);
  if (decision.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(decision)}`);
  return decision.plan;
}

describe('resolveMediaUploadBatchRequest — the whole batch', () => {
  it.each([
    ['no payload', undefined],
    ['no requestId', { purpose: 'generationSource', items: [] }],
    ['an empty requestId', { requestId: '', purpose: 'generationSource', items: [] }],
  ])('drops %s: no reply could be correlated', (_label, raw) => {
    expect(resolveMediaUploadBatchRequest(raw)).toEqual({ kind: 'drop' });
  });

  it.each([
    ['a wrong purpose', req([], { purpose: 'trainingData' }), "purpose must be 'generationSource'"],
    ['items not an array', req([], { items: 'x' }), 'invalid media-upload batch request'],
    ['an item that is not an object', req([null]), 'invalid media-upload batch request'],
    ['no items', req([]), 'a batch holds 1 to 1200 files'],
  ])('refuses %s, for the whole batch', (_label, raw, error) => {
    expect(resolveMediaUploadBatchRequest(raw)).toEqual({
      kind: 'refuse',
      requestId: 'rq_batch',
      error,
    });
  });

  it('admits 1,200 files and refuses 1,201', () => {
    const one = buf(PNG);
    const items = (n: number) => Array.from({ length: n }, () => ({ kind: 'image', bytes: one }));
    expect(plan(req(items(1200))).files).toHaveLength(1200);
    expect(resolveMediaUploadBatchRequest(req(items(1201)))).toMatchObject({
      kind: 'refuse',
      error: 'a batch holds 1 to 1200 files',
    });
  });

  it('admits exactly 10 GiB in total and refuses one byte more', () => {
    // 1,024 × 10 MiB = 10 GiB (10,737,418,240 bytes). One shared buffer, so the fixture holds
    // 20 MiB, not 10 GiB.
    const tenMiB = buf(PNG, 10_485_760);
    const items = Array.from({ length: 1024 }, () => ({ kind: 'image', bytes: tenMiB }));
    expect(plan(req(items)).files).toHaveLength(1024);
    const over = [...items.slice(1), { kind: 'image', bytes: buf(PNG, 10_485_761) }];
    expect(resolveMediaUploadBatchRequest(req(over))).toMatchObject({
      kind: 'refuse',
      error: 'the batch exceeds the 10 GB limit',
    });
  });

  it('admits a batch between 5 GiB and 10 GiB (about 6.8 GiB)', () => {
    const tenMiB = buf(PNG, 10_485_760);
    const items = Array.from({ length: 700 }, () => ({ kind: 'image', bytes: tenMiB }));
    expect(plan(req(items)).files).toHaveLength(700);
  });
});

describe('resolveMediaUploadBatchRequest — each item, as a single bytes upload checks it', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      'a GIF sent as an image',
      { kind: 'image', bytes: buf(GIF) },
      'images must be PNG, JPEG or WebP',
    ],
    ['a WAV sent as a video', { kind: 'video', bytes: buf(WAV) }, 'videos must be MP4 or WebM'],
    ['a PNG sent as audio', { kind: 'audio', bytes: buf(PNG) }, 'audio must be MP3, WAV or WebM'],
    [
      'an image over its 24 MB cap',
      { kind: 'image', bytes: buf(PNG, 24 * 1024 * 1024 + 1) },
      'file exceeds the 24 MB image upload limit',
    ],
    [
      'audio over the 64 MB cap',
      { kind: 'audio', bytes: buf(WAV, 64 * 1024 * 1024 + 1) },
      'file exceeds the 64 MB upload limit',
    ],
    [
      'a declared type the content contradicts',
      { kind: 'image', bytes: buf(PNG), mimeType: 'image/jpeg' },
      "mimeType does not match the file's content",
    ],
  ];

  it.each(cases)('refuses %s with the single upload’s own error', (_label, item, error) => {
    const p = plan(req([item]));
    expect(p.refusals).toEqual([error]);
    expect(p.files).toEqual([]);
    // The same bytes through the single path, with an empty window, refuse identically.
    const single = processMediaUploadBytes(
      item as { kind: 'image'; bytes: ArrayBuffer; mimeType?: string },
      [],
      0
    );
    expect(single.result).toEqual({ ok: false, error });
  });

  it.each([
    [
      'an unknown kind',
      { kind: 'gif', bytes: buf(PNG) },
      "kind must be 'image', 'video' or 'audio'",
    ],
    [
      'bytes that are not an ArrayBuffer',
      { kind: 'image', bytes: new Uint8Array(PNG) },
      'invalid media-upload request',
    ],
    [
      'an empty buffer',
      { kind: 'image', bytes: new ArrayBuffer(0) },
      'invalid media-upload request',
    ],
    [
      'a non-string mimeType',
      { kind: 'image', bytes: buf(PNG), mimeType: 7 },
      'invalid media-upload request',
    ],
  ])('refuses %s for that item only', (_label, item, error) => {
    const p = plan(req([item, { kind: 'image', bytes: buf(PNG) }]));
    expect(p.refusals).toEqual([error, null]);
    expect(p.files.map((f) => f.index)).toEqual([1]);
  });

  it('keeps every valid item with its index and sniffed type, whatever surrounds it', () => {
    const p = plan(
      req([
        { kind: 'audio', bytes: buf(WAV), mimeType: 'audio/x-wav' },
        { kind: 'image', bytes: buf(GIF) },
        { kind: 'image', bytes: buf(PNG) },
      ])
    );
    expect(p.refusals).toEqual([null, 'images must be PNG, JPEG or WebP', null]);
    expect(p.files.map((f) => [f.index, f.kind, f.contentType])).toEqual([
      [0, 'audio', 'audio/wav'],
      [2, 'image', 'image/png'],
    ]);
  });

  it('has no per-minute window: 20 files are all admitted where a single upload refuses the 9th', () => {
    const items = Array.from({ length: 20 }, () => ({ kind: 'audio', bytes: buf(WAV) }));
    expect(plan(req(items)).refusals).toEqual(new Array(20).fill(null));
    // INVARIANT GUARD (the single window must not have changed): 8 per 60 s, then busy.
    let recent: ReturnType<typeof processMediaUploadBytes>['recent'] = [];
    const outcomes: unknown[] = [];
    for (let i = 0; i < MEDIA_UPLOAD_WINDOW_LIMITS.maxPerWindow + 1; i++) {
      const out = processMediaUploadBytes({ kind: 'audio', bytes: buf(WAV) }, recent, 1000 + i);
      recent = out.recent;
      outcomes.push(out.result);
    }
    expect(MEDIA_UPLOAD_WINDOW_LIMITS.maxPerWindow).toBe(8);
    expect(outcomes.at(-1)).toEqual({ ok: false, error: 'busy' });
    expect(outcomes.slice(0, 8).every((o) => (o as { ok: boolean }).ok)).toBe(true);
  });
});

describe('runWithConcurrency', () => {
  it('runs at most `limit` tasks at once, keeps item order, and runs every item once', async () => {
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await runWithConcurrency(items, 3, async (i) => {
      started.push(i);
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later items finish sooner, so order is not an accident of timing.
      await new Promise((r) => setTimeout(r, (10 - i) * 2));
      inFlight--;
      return i * 10;
    });
    expect(peak).toBe(3);
    expect(results).toEqual(items.map((i) => i * 10));
    expect([...started].sort((a, b) => a - b)).toEqual(items);
  });

  it('starts no more workers than there are items', async () => {
    let peak = 0;
    let inFlight = 0;
    await runWithConcurrency([1, 2], 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBe(2);
  });
});

describe('buildMediaUploadBatchConfirmCopy', () => {
  it('counts the files and their size, and names the app', () => {
    const files = Array.from({ length: 80 }, () => ({
      kind: 'image' as const,
      bytes: new ArrayBuffer(Math.round(3.9 * 1024 * 1024)),
    }));
    const { message } = buildMediaUploadBatchConfirmCopy({ appName: 'Caption Lab', files });
    expect(message).toMatch(/^Upload 80 images \(312 MB\) for “Caption Lab”\?/);
    expect(message).toContain('kept for at least 30 days');
  });

  it('says "files" for a mix of kinds and "this app" with no name', () => {
    const copy = buildMediaUploadBatchConfirmCopy({
      appName: '',
      files: [
        { kind: 'image', bytes: new ArrayBuffer(1024 * 1024) },
        { kind: 'audio', bytes: new ArrayBuffer(1024 * 1024) },
      ],
    });
    expect(copy.message).toMatch(/^Upload 2 files \(2\.0 MB\) for this app\?/);
  });

  it('is singular for one file', () => {
    const copy = buildMediaUploadBatchConfirmCopy({
      appName: 'X',
      files: [{ kind: 'video', bytes: new ArrayBuffer(10) }],
    });
    expect(copy.message).toMatch(/^Upload 1 video /);
  });
});

describe('buildMediaUploadBatchResults', () => {
  it('answers every item in order: its refusal, its upload, or a failure if neither', () => {
    const selected = { url: 'u', kind: 'image' as const, mimeType: 'image/jpeg', sizeBytes: 1 };
    const results = buildMediaUploadBatchResults(
      { refusals: ['images must be PNG, JPEG or WebP', null, null] },
      new Map([[1, { index: 1, selected }]])
    );
    expect(results).toEqual([
      { index: 0, error: 'images must be PNG, JPEG or WebP' },
      { index: 1, selected },
      { index: 2, error: 'media upload failed — please try again' },
    ]);
  });
});

describe('mediaUploadBatchStartError', () => {
  it('relays the server’s viewer-facing refusals', () => {
    const quota = { data: { code: 'TOO_MANY_REQUESTS' }, message: 'quota message' };
    expect(mediaUploadBatchStartError(quota)).toBe('quota message');
    const off = { data: { code: 'FORBIDDEN' }, message: 'batch media upload is not available' };
    expect(mediaUploadBatchStartError(off)).toBe('batch media upload is not available');
  });

  it('replaces anything else with a fixed message', () => {
    const internal = { data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'SECRET stack text' };
    expect(mediaUploadBatchStartError(internal)).toBe('media upload failed — please try again');
    expect(mediaUploadBatchStartError(new TypeError('fetch failed'))).toBe(
      'media upload failed — please try again'
    );
  });
});
