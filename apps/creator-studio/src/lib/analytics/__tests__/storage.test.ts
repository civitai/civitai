import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  mediaStatus,
  needsMediaRefresh,
  storageEmptyKind,
  summarizeStorage,
  type StorageRow,
} from '$lib/analytics/storage';

const row = (r: Partial<StorageRow>): StorageRow => ({
  kind: 'model',
  publicStatus: 'public',
  baseModel: '',
  month: '2026-01-01',
  fileCount: 1,
  bytes: 100,
  ...r,
});

describe('summarizeStorage', () => {
  it('keeps not-public content out of the headline and every chart', () => {
    const s = summarizeStorage([
      row({ kind: 'model', baseModel: 'SDXL 1.0', bytes: 1000, fileCount: 2 }),
      row({ kind: 'image', bytes: 50, fileCount: 5 }),
      row({ kind: 'model', baseModel: 'SDXL 1.0', publicStatus: 'notPublic', bytes: 9999 }),
      row({ kind: 'video', publicStatus: 'notPublic', bytes: 777, month: '2026-03-01' }),
    ]);
    expect(s.total).toEqual({ bytes: 1050, fileCount: 7 });
    expect(s.notPublic).toEqual({ bytes: 10776, fileCount: 2 });
    expect(s.byKind.map((k) => [k.kind, k.bytes])).toEqual([
      ['model', 1000],
      ['image', 50],
    ]);
    expect(s.baseModels).toEqual([{ baseModel: 'SDXL 1.0', bytes: 1000, fileCount: 2 }]);
    expect(s.months).toEqual([{ month: '2026-01-01', bytesByKind: { model: 1000, image: 50 } }]);
  });

  it('charts base models from model files only, top ten plus Other', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ baseModel: `BM${i}`, bytes: (i + 1) * 10, fileCount: 1 })
    );
    rows.push(row({ kind: 'training', baseModel: 'BM0', bytes: 100000 }));
    const s = summarizeStorage(rows);
    expect(s.baseModels.map((b) => b.baseModel)).toEqual([
      'BM11',
      'BM10',
      'BM9',
      'BM8',
      'BM7',
      'BM6',
      'BM5',
      'BM4',
      'BM3',
      'BM2',
    ]);
    expect(s.otherBaseModels).toEqual({ bytes: 30, fileCount: 2 });
  });

  // Image.type is MediaType (image | video | audio); the job writes it through as `kind`.
  it('labels every MediaType kind, and keeps an unknown kind rather than dropping its bytes', () => {
    const s = summarizeStorage([
      row({ kind: 'audio', bytes: 30 }),
      row({ kind: 'video', bytes: 20 }),
      row({ kind: 'image', bytes: 10 }),
      row({ kind: 'hologram', bytes: 5 }),
    ]);
    expect(s.byKind.map((k) => [k.kind, k.label, k.bytes])).toEqual([
      ['image', 'Images', 10],
      ['video', 'Videos', 20],
      ['audio', 'Audio', 30],
      ['hologram', 'hologram', 5],
    ]);
    expect(s.total.bytes).toBe(65);
  });

  it('orders months and kinds', () => {
    const s = summarizeStorage([
      row({ kind: 'video', month: '2026-02-01' }),
      row({ kind: 'model', month: '2025-12-01' }),
      row({ kind: 'image', month: '2026-02-01' }),
    ]);
    expect(s.months.map((m) => m.month)).toEqual(['2025-12-01', '2026-02-01']);
    expect(s.kinds).toEqual(['model', 'image', 'video']);
  });
});

describe('storageEmptyKind', () => {
  // A creator who uploads today has no rollup rows until the nightly job, while the live per-model table
  // already lists the upload. "Nothing here yet" above that table would be false.
  it('says totals update overnight when the live table has models but the rollup has none', () => {
    expect(storageEmptyKind(summarizeStorage([]), 2)).toBe('overnight');
  });

  it('says nothing is here only when the live table is empty too', () => {
    expect(storageEmptyKind(summarizeStorage([]), 0)).toBe('none');
  });

  it('never claims nothing is here when the live table could not be read', () => {
    expect(storageEmptyKind(summarizeStorage([]), null)).toBe('overnight');
  });

  it('is not empty when only not-public content exists', () => {
    expect(storageEmptyKind(summarizeStorage([row({ publicStatus: 'notPublic' })]), 0)).toBeNull();
  });
});

describe('media rollup state', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');

  it('queues a first visit and nothing while a request is pending', () => {
    expect(needsMediaRefresh(null, now)).toBe(true);
    expect(mediaStatus(null, now)).toBe('first');
    const pending = { requestedAt: '2026-09-25T11:59:00.000Z', computedAt: null };
    expect(needsMediaRefresh(pending, now)).toBe(false);
    expect(mediaStatus(pending, now)).toBe('first');
  });

  it('refreshes only once the last completed rollup is over 24 hours old', () => {
    const fresh = {
      requestedAt: '2026-09-24T13:00:00.000Z',
      computedAt: '2026-09-24T13:01:00.000Z',
    };
    expect(needsMediaRefresh(fresh, now)).toBe(false);
    expect(mediaStatus(fresh, now)).toBe('done');
    const stale = {
      requestedAt: '2026-09-24T11:00:00.000Z',
      computedAt: '2026-09-24T11:01:00.000Z',
    };
    expect(needsMediaRefresh(stale, now)).toBe(true);
    expect(mediaStatus(stale, now)).toBe('done');
  });

  it('does not requeue a refresh that is already queued behind a completed rollup', () => {
    const requeued = {
      requestedAt: '2026-09-25T11:00:00.000Z',
      computedAt: '2026-09-23T11:00:00.000Z',
    };
    expect(needsMediaRefresh(requeued, now)).toBe(false);
    expect(mediaStatus(requeued, now)).toBe('refreshing');
  });

  it('reports a request pending for over an hour as slow, first count or refresh alike', () => {
    expect(mediaStatus({ requestedAt: '2026-09-25T10:00:00.000Z', computedAt: null }, now)).toBe(
      'slow'
    );
    expect(
      mediaStatus(
        { requestedAt: '2026-09-25T10:00:00.000Z', computedAt: '2026-09-23T10:00:00.000Z' },
        now
      )
    ).toBe('slow');
  });
});

describe('formatBytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB');
  });
});
