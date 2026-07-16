import { describe, it, expect } from 'vitest';

import { classifyGatedImageForViewer } from '~/server/services/blocks/block-gated-images.logic';
import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

// Viewer ceilings expressed as browsing-level bitmasks.
const SFW = NsfwLevel.PG | NsfwLevel.PG13; // 3 — a SFW viewer
const UP_TO_R = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R; // 7 — an R-allowed viewer

const scannedClean = {
  ingestion: ImageIngestionStatus.Scanned,
  nsfwLevel: NsfwLevel.PG,
  needsReview: null,
  poi: false,
  minor: false,
  tosViolation: false,
  acceptableMinor: false,
};

describe('classifyGatedImageForViewer', () => {
  it('shows a scanned, clean, within-ceiling image', () => {
    expect(classifyGatedImageForViewer(scannedClean, SFW)).toEqual({ status: 'visible' });
  });

  it('HIDES an above-ceiling image from a viewer whose ceiling excludes it', () => {
    // An R image is hidden from a SFW viewer, but visible to an R-allowed viewer.
    const rImage = { ...scannedClean, nsfwLevel: NsfwLevel.R };
    expect(classifyGatedImageForViewer(rImage, SFW)).toEqual({ status: 'hidden' });
    expect(classifyGatedImageForViewer(rImage, UP_TO_R)).toEqual({ status: 'visible' });
  });

  it('HIDES an X image from an R-allowed viewer (still above their ceiling)', () => {
    const xImage = { ...scannedClean, nsfwLevel: NsfwLevel.X };
    expect(classifyGatedImageForViewer(xImage, UP_TO_R)).toEqual({ status: 'hidden' });
  });

  it('HIDES an unscanned image (ingestion not Scanned) for EVERYONE', () => {
    for (const ingestion of [
      ImageIngestionStatus.Pending,
      ImageIngestionStatus.Blocked,
      ImageIngestionStatus.NotFound,
      ImageIngestionStatus.PendingManualAssignment,
    ]) {
      expect(classifyGatedImageForViewer({ ...scannedClean, ingestion }, UP_TO_R)).toEqual({
        status: 'hidden',
      });
    }
  });

  it('HIDES a scanned-but-unrated image (nsfwLevel 0)', () => {
    expect(classifyGatedImageForViewer({ ...scannedClean, nsfwLevel: 0 }, UP_TO_R)).toEqual({
      status: 'hidden',
    });
  });

  it('HIDES on ANY moderation flag a Scanned ingestion does not clear', () => {
    const flagged = [
      { ...scannedClean, needsReview: 'poi' },
      { ...scannedClean, poi: true },
      { ...scannedClean, minor: true },
      { ...scannedClean, tosViolation: true },
      { ...scannedClean, acceptableMinor: true },
    ];
    for (const image of flagged) {
      expect(classifyGatedImageForViewer(image, UP_TO_R)).toEqual({ status: 'hidden' });
    }
  });

  it('HIDES everything when the viewer ceiling is empty (fail-closed 0 clamp)', () => {
    expect(classifyGatedImageForViewer(scannedClean, 0)).toEqual({ status: 'hidden' });
  });

  it('is a pure function of the row + ceiling — no owner bypass', () => {
    // There is no userId param: an unscanned image is hidden regardless of who asks.
    const pending = { ...scannedClean, ingestion: ImageIngestionStatus.Pending };
    expect(classifyGatedImageForViewer(pending, UP_TO_R)).toEqual({ status: 'hidden' });
  });
});
