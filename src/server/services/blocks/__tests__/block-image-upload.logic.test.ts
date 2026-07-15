import { describe, it, expect } from 'vitest';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';
import {
  classifyBlockImageUploadScan,
  isWithinSfwImageCeiling,
} from '~/server/services/blocks/block-image-upload.logic';

/**
 * App Blocks (Phase-2a PR-C) — the PURE scan-gate for the OPEN_IMAGE_UPLOAD block
 * image-upload bridge. Proves the pending/scanned/blocked discriminant AND the SFW
 * ceiling + moderation-flag rejection (a PUBLIC block image, unlike a mod-reviewed
 * listing asset, may NOT be mature or flagged) by mocking each scan state.
 */

describe('classifyBlockImageUploadScan — pending / scanned / blocked + SFW ceiling', () => {
  it('PENDING while the scan is in-flight (Pending / retry / PendingManualAssignment)', () => {
    for (const ingestion of [
      ImageIngestionStatus.Pending,
      ImageIngestionStatus.Error,
      ImageIngestionStatus.PendingManualAssignment,
    ]) {
      expect(classifyBlockImageUploadScan({ ingestion, nsfwLevel: NsfwLevel.PG })).toEqual({
        status: 'pending',
      });
    }
  });

  it('READY when Scanned AND within the SFW ceiling (PG / PG-13 / level 0)', () => {
    // PG (and level 0) map to the safest rating 'g' via contentRatingFromNsfwLevel.
    expect(
      classifyBlockImageUploadScan({ ingestion: ImageIngestionStatus.Scanned, nsfwLevel: NsfwLevel.PG })
    ).toEqual({ status: 'ready', contentRating: 'g' });
    expect(
      classifyBlockImageUploadScan({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: NsfwLevel.PG13,
      })
    ).toEqual({ status: 'ready', contentRating: 'pg13' });
    // Level 0 (no maturity signal) → within ceiling, rating floors to 'g'.
    expect(
      classifyBlockImageUploadScan({ ingestion: ImageIngestionStatus.Scanned, nsfwLevel: 0 })
    ).toEqual({ status: 'ready', contentRating: 'g' });
  });

  it('BLOCKED-NSFW when Scanned but ABOVE the SFW ceiling (R / X / XXX)', () => {
    for (const level of [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX]) {
      const out = classifyBlockImageUploadScan({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: level,
      });
      expect(out.status).toBe('blocked-nsfw');
    }
  });

  it('BLOCKED-FLAGGED when Scanned but carrying a moderation flag (needsReview/poi/minor/tosViolation)', () => {
    const scanned = { ingestion: ImageIngestionStatus.Scanned, nsfwLevel: NsfwLevel.PG };
    expect(classifyBlockImageUploadScan({ ...scanned, needsReview: 'poi' })).toEqual({
      status: 'blocked-flagged',
    });
    expect(classifyBlockImageUploadScan({ ...scanned, poi: true })).toEqual({
      status: 'blocked-flagged',
    });
    expect(classifyBlockImageUploadScan({ ...scanned, minor: true })).toEqual({
      status: 'blocked-flagged',
    });
    expect(classifyBlockImageUploadScan({ ...scanned, tosViolation: true })).toEqual({
      status: 'blocked-flagged',
    });
  });

  it('a flag takes PRECEDENCE over an otherwise-ready SFW image', () => {
    // Even a perfectly SFW (PG) scanned image is blocked when flagged.
    expect(
      classifyBlockImageUploadScan({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: NsfwLevel.PG,
        minor: true,
      }).status
    ).toBe('blocked-flagged');
  });

  it('READY is unaffected by explicitly-cleared flags (false / null)', () => {
    expect(
      classifyBlockImageUploadScan({
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: NsfwLevel.PG,
        needsReview: null,
        poi: false,
        minor: false,
        tosViolation: false,
      })
    ).toEqual({ status: 'ready', contentRating: 'g' });
  });

  it('BLOCKED-SCAN when the scanner rejected the bytes (Blocked)', () => {
    expect(
      classifyBlockImageUploadScan({
        ingestion: ImageIngestionStatus.Blocked,
        nsfwLevel: NsfwLevel.PG,
      })
    ).toEqual({ status: 'blocked-scan' });
  });

  it('IMPORT-FAILED when the scanner could not fetch the bytes (NotFound)', () => {
    expect(
      classifyBlockImageUploadScan({
        ingestion: ImageIngestionStatus.NotFound,
        nsfwLevel: NsfwLevel.PG,
      })
    ).toEqual({ status: 'import-failed' });
  });
});

describe('isWithinSfwImageCeiling', () => {
  it('true for SFW levels (0 / PG / PG-13)', () => {
    expect(isWithinSfwImageCeiling(0)).toBe(true);
    expect(isWithinSfwImageCeiling(NsfwLevel.PG)).toBe(true);
    expect(isWithinSfwImageCeiling(NsfwLevel.PG13)).toBe(true);
  });
  it('false for any mature bit (R and above)', () => {
    expect(isWithinSfwImageCeiling(NsfwLevel.R)).toBe(false);
    expect(isWithinSfwImageCeiling(NsfwLevel.X)).toBe(false);
    expect(isWithinSfwImageCeiling(NsfwLevel.XXX)).toBe(false);
    // A mixed level (PG + R) still exceeds — any nsfw bit fails the ceiling.
    expect(isWithinSfwImageCeiling(NsfwLevel.PG | NsfwLevel.R)).toBe(false);
  });
});
