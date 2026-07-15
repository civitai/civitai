import { describe, it, expect } from 'vitest';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';
import {
  classifyCosmeticImageScan,
  isWithinSfwCosmeticCeiling,
} from '~/server/services/blocks/generator-cosmetic-image.logic';

/**
 * Custom Generators (Phase-2a PR-C) — the PURE scan-gate for the OPEN_IMAGE_UPLOAD
 * cosmetic-background bridge. Proves the pending/scanned/blocked discriminant AND
 * the SFW ceiling (a PUBLIC cosmetic image, unlike a mod-reviewed listing asset,
 * may NOT be mature) by mocking each scan state.
 */

describe('classifyCosmeticImageScan — pending / scanned / blocked + SFW ceiling', () => {
  it('PENDING while the scan is in-flight (Pending / retry / PendingManualAssignment)', () => {
    for (const ingestion of [
      ImageIngestionStatus.Pending,
      ImageIngestionStatus.Error,
      ImageIngestionStatus.PendingManualAssignment,
    ]) {
      expect(classifyCosmeticImageScan({ ingestion, nsfwLevel: NsfwLevel.PG })).toEqual({
        status: 'pending',
      });
    }
  });

  it('READY when Scanned AND within the SFW ceiling (PG / PG-13 / level 0)', () => {
    // PG (and level 0) map to the safest rating 'g' via contentRatingFromNsfwLevel.
    expect(
      classifyCosmeticImageScan({ ingestion: ImageIngestionStatus.Scanned, nsfwLevel: NsfwLevel.PG })
    ).toEqual({ status: 'ready', contentRating: 'g' });
    expect(
      classifyCosmeticImageScan({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: NsfwLevel.PG13,
      })
    ).toEqual({ status: 'ready', contentRating: 'pg13' });
    // Level 0 (no maturity signal) → within ceiling, rating floors to 'g'.
    expect(
      classifyCosmeticImageScan({ ingestion: ImageIngestionStatus.Scanned, nsfwLevel: 0 })
    ).toEqual({ status: 'ready', contentRating: 'g' });
  });

  it('BLOCKED-NSFW when Scanned but ABOVE the SFW ceiling (R / X / XXX)', () => {
    for (const level of [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX]) {
      const out = classifyCosmeticImageScan({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: level,
      });
      expect(out.status).toBe('blocked-nsfw');
    }
  });

  it('BLOCKED-SCAN when the scanner rejected the bytes (Blocked)', () => {
    expect(
      classifyCosmeticImageScan({
        ingestion: ImageIngestionStatus.Blocked,
        nsfwLevel: NsfwLevel.PG,
      })
    ).toEqual({ status: 'blocked-scan' });
  });

  it('IMPORT-FAILED when the scanner could not fetch the bytes (NotFound)', () => {
    expect(
      classifyCosmeticImageScan({
        ingestion: ImageIngestionStatus.NotFound,
        nsfwLevel: NsfwLevel.PG,
      })
    ).toEqual({ status: 'import-failed' });
  });
});

describe('isWithinSfwCosmeticCeiling', () => {
  it('true for SFW levels (0 / PG / PG-13)', () => {
    expect(isWithinSfwCosmeticCeiling(0)).toBe(true);
    expect(isWithinSfwCosmeticCeiling(NsfwLevel.PG)).toBe(true);
    expect(isWithinSfwCosmeticCeiling(NsfwLevel.PG13)).toBe(true);
  });
  it('false for any mature bit (R and above)', () => {
    expect(isWithinSfwCosmeticCeiling(NsfwLevel.R)).toBe(false);
    expect(isWithinSfwCosmeticCeiling(NsfwLevel.X)).toBe(false);
    expect(isWithinSfwCosmeticCeiling(NsfwLevel.XXX)).toBe(false);
    // A mixed level (PG + R) still exceeds — any nsfw bit fails the ceiling.
    expect(isWithinSfwCosmeticCeiling(NsfwLevel.PG | NsfwLevel.R)).toBe(false);
  });
});
