import { describe, expect, it } from 'vitest';
import { isNearStorageLimit, storagePercent } from '~/shared/utils/app-storage-usage';

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
