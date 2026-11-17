import { describe, expect, it } from 'vitest';
import {
  clearableDocs,
  isNearStorageLimit,
  keptStorageNote,
  storagePercent,
} from '~/shared/utils/app-storage-usage';

// Ceilings distinct from the store's defaults (2 MiB, 1,000 documents) and from each other, so a
// threshold read off the wrong ceiling, or a hard-coded default, moves the answer.
const LIMITS = { userBytes: 5_000, userDocs: 50 };

describe('isNearStorageLimit', () => {
  it('is false just under 80% of both ceilings', () => {
    expect(isNearStorageLimit({ bytes: 3_999, docs: 39 }, LIMITS)).toBe(false);
  });

  it('is true from exactly 80% of the byte ceiling, whatever the document count', () => {
    expect(isNearStorageLimit({ bytes: 4_000, docs: 0 }, LIMITS)).toBe(true);
    expect(isNearStorageLimit({ bytes: 4_001, docs: 1 }, LIMITS)).toBe(true);
  });

  it('is true from exactly 80% of the document ceiling, whatever the bytes', () => {
    expect(isNearStorageLimit({ bytes: 0, docs: 40 }, LIMITS)).toBe(true);
    expect(isNearStorageLimit({ bytes: 1, docs: 41 }, LIMITS)).toBe(true);
  });

  it('reads each figure against its own ceiling, never the other', () => {
    // 41 bytes would be 82% of the document ceiling; it is 0.8% of the byte one.
    expect(isNearStorageLimit({ bytes: 41, docs: 0 }, LIMITS)).toBe(false);
    // 39 documents would be 97% of a 40-byte ceiling; it is 78% of the document one.
    expect(isNearStorageLimit({ bytes: 0, docs: 39 }, { userBytes: 40, userDocs: 50 })).toBe(false);
  });

  it('is true over a ceiling (one lowered after the data was written)', () => {
    expect(isNearStorageLimit({ bytes: 9_999, docs: 0 }, LIMITS)).toBe(true);
  });

  it('ignores a zero ceiling rather than dividing by it', () => {
    expect(isNearStorageLimit({ bytes: 10, docs: 10 }, { userBytes: 0, userDocs: 0 })).toBe(false);
  });
});

describe('storagePercent', () => {
  it('rounds to a whole percentage and clamps to 0–100', () => {
    expect(storagePercent(1_234, 5_000)).toBe(25);
    expect(storagePercent(9_999, 5_000)).toBe(100);
    expect(storagePercent(10, 0)).toBe(0);
  });
});

describe('what an Empty leaves', () => {
  const NONE = { bytes: 0, docs: 0 };
  const h = (parts: Record<string, { bytes: number; docs: number }>) => ({
    private: NONE,
    shared: NONE,
    hidden: NONE,
    counters: NONE,
    ...parts,
  });

  it('clearable documents are the private ones and the visible shared ones, never hidden posts or counters', () => {
    expect(
      clearableDocs(
        h({
          private: { bytes: 1, docs: 3 },
          shared: { bytes: 1, docs: 5 },
          hidden: { bytes: 1, docs: 7 },
          counters: { bytes: 1, docs: 11 },
        })
      )
    ).toBe(8);
    expect(
      clearableDocs(h({ hidden: { bytes: 4, docs: 1 }, counters: { bytes: 2, docs: 1 } }))
    ).toBe(0);
  });

  it('names what stays, counted in items', () => {
    expect(keptStorageNote(h({ counters: { bytes: 2, docs: 1 } }))).toBe(
      '1 item stays: counters you started.'
    );
    expect(keptStorageNote(h({ hidden: { bytes: 40, docs: 3 } }))).toBe(
      '3 items stay: posts hidden by moderation.'
    );
    expect(
      keptStorageNote(h({ hidden: { bytes: 40, docs: 3 }, counters: { bytes: 2, docs: 4 } }))
    ).toBe('7 items stay: counters you started and posts hidden by moderation.');
  });

  it('is null when an Empty can remove everything', () => {
    expect(
      keptStorageNote(h({ private: { bytes: 9, docs: 2 }, shared: { bytes: 9, docs: 6 } }))
    ).toBeNull();
  });
});
